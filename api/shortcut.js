// Dorset House Report Bot - iOS Shortcuts Endpoint
const OpenAI = require('openai');
const axios = require('axios');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const formidable = require('formidable');
const fs = require('fs');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LOGO_URL = "https://publicbucket3222.blob.core.windows.net/$web/report/logo.jpg";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function normaliseSubjectName(raw) {
  if (!raw || typeof raw !== "string") return "Subject";
  const s = raw.trim().toLowerCase();

  if (["english", "eng"].includes(s)) return "English";
  if (["math", "maths", "mathematics"].includes(s)) return "Maths";
  if (["science"].includes(s)) return "Science";
  if (["pe", "p.e", "p.e.", "physical education"].includes(s)) return "PE";
  if (["reading"].includes(s)) return "Reading";
  if (["writing"].includes(s)) return "Writing";

  return raw
    .split(" ")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function normaliseCommentText(raw) {
  if (!raw || typeof raw !== "string") return "";
  const lower = raw.toLowerCase();
  if (lower.includes("#no_comment#") || lower.includes("no comment")) {
    return "";
  }
  return raw.trim();
}

module.exports = async (req, res) => {
  // Handle CORS for iOS Shortcuts
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Parse multipart form data from iOS Shortcuts
    const form = formidable({ uploadDir: '/tmp', keepExtensions: true });
    
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ fields, files });
      });
    });

    const audioFile = files.audio?.[0] || files.file?.[0];
    if (!audioFile) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    // Read audio file
    const audioBuffer = fs.readFileSync(audioFile.filepath);
    const audioFileObj = new File([audioBuffer], audioFile.originalFilename || "voice.m4a", { 
      type: audioFile.mimetype || "audio/m4a" 
    });

    // Whisper transcription
    const transcription = await openai.audio.transcriptions.create({
      file: audioFileObj,
      model: "whisper-1",
      language: "en"
    });

    // Split students
    const segments = transcription.text
      .toLowerCase()
      .split("next student")
      .map(s => s.trim())
      .filter(s => s.length > 0);

    const allPDFs = [];

    // Process each student
    for (let i = 0; i < segments.length; i++) {
      const studentText = segments[i];

      // Smart parser
      const parsePrompt = `
You will be given a short, spoken-style description for a single pupil.

The teacher may:
- Mention subjects in any order.
- Mention only some subjects.
- Give scores, comments, both, or neither.
- Miss some subjects entirely.
- Speak casually or inconsistently.
- Say phrases like "teachers notes", "teacher notes", "now teacher notes", or "#teachers_notes#" to move from subject-level info to general notes.

INTERPRETATION RULES
1. Everything that is clearly tied to a specific subject (e.g. "english 5 great work", "maths 5 struggled a bit", "pe he is doing really well") should be treated as SUBJECT-LEVEL information.
2. Anything AFTER a "teacher notes" marker ("teacher notes", "teachers notes", "now teacher notes", "#teachers_notes#") should be treated as general TEACHER NOTES about the pupil overall.
3. If there is no explicit teacher-notes marker, treat comments clearly about the whole term or the child's general attitude as TEACHER NOTES.
4. If the teacher says "no comment" or "#no_comment#" for a subject, that subject's comment must be an empty string "".

YOUR JOB:
Return ONLY strict JSON in this format:

{
  "student_name": "Name or best guess",
  "scores": {
    "<subject>": <integer 0-10>,
    "<subject>": <integer 0-10>
  },
  "subject_comments": {
    "<subject>": "short comment about this subject or empty string",
    "<subject>": ""
  },
  "teacher_notes": "general notes about the pupil or empty string"
}

DETAILED RULES:
- Only include subjects that were actually mentioned in the text.
- A subject may have: a score only, a comment only, a score and a comment, or neither (then do not include it).
- If a clear numerical score 0–10 is given for a subject, put it in "scores".
- If descriptive words follow a subject or score that clearly describe performance in that subject, put them in "subject_comments[subject]".
- If the teacher says "no comment" or "#no_comment#" for a subject, set "subject_comments[subject]" to "".
- General remarks that are not tied to any single subject (especially after a teacher-notes marker) go into "teacher_notes".
- If there are no clear general notes, "teacher_notes" should be "".
- Never use null. Use empty objects {} and empty strings "" when needed.
- Do NOT add or invent subjects, scores, or achievements.

TEXT:
"""${studentText}"""
`;

      const parseResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [{ role: "user", content: parsePrompt }]
      });

      let data;
      try {
        let jsonText = parseResp.choices?.[0]?.message?.content || "";
        jsonText = jsonText.replace(/```json|```/gi, "").trim();
        if (!jsonText) continue;
        data = JSON.parse(jsonText);
      } catch (e) {
        console.error("JSON parse error for student", i + 1, e);
        continue;
      }

      if (!data || typeof data !== "object") continue;

      // Harden data structure
      if (!data.student_name || typeof data.student_name !== "string") {
        data.student_name = `Student ${i + 1}`;
      }

      if (typeof data.teacher_notes !== "string") {
        data.teacher_notes = "";
      }

      // Clean scores
      const rawScores = (data.scores && typeof data.scores === "object") ? data.scores : {};
      const cleanedScores = {};

      for (const [rawSubject, rawValue] of Object.entries(rawScores)) {
        const subject = normaliseSubjectName(rawSubject);
        const n = Number(rawValue);
        if (!Number.isFinite(n)) continue;
        const clamped = Math.max(0, Math.min(10, Math.round(n)));
        cleanedScores[subject] = clamped;
      }

      data.scores = cleanedScores;

      // Clean subject comments
      const rawSubjectComments = (data.subject_comments && typeof data.subject_comments === "object")
        ? data.subject_comments
        : {};
      const cleanedSubjectComments = {};

      for (const [rawSubject, rawComment] of Object.entries(rawSubjectComments)) {
        const subject = normaliseSubjectName(rawSubject);
        const commentText = normaliseCommentText(rawComment);
        cleanedSubjectComments[subject] = commentText;
      }

      for (const subject of Object.keys(data.scores)) {
        if (!(subject in cleanedSubjectComments)) {
          cleanedSubjectComments[subject] = "";
        }
      }

      data.subject_comments = cleanedSubjectComments;

      if (!data.scores || typeof data.scores !== "object") {
        data.scores = {};
      }
      if (!data.subject_comments || typeof data.subject_comments !== "object") {
        data.subject_comments = {};
      }

      // Generate written report
      const scoreLines = Object.entries(data.scores || {})
        .map(([s, v]) => `- ${s}: ${v}/10`)
        .join("\n");

      const commentLines = Object.entries(data.subject_comments || {})
        .filter(([, c]) => c && c.trim().length > 0)
        .map(([s, c]) => `- ${s}: ${c}`)
        .join("\n");

      const reportPrompt = `
Write an 80–100 word British school report for ${data.student_name}.

TONE:
Use a casual but respectful tone: friendly, modern, and down-to-earth, like a 25-year-old teacher speaking naturally to parents.
Warm, supportive, and clear. No clichés. No invented details. Must sound real and human.

INSTRUCTIONS:
- Base the report primarily on the subjects and scores provided.
- Use "teacher_notes" as general guidance about the pupil's term.
- You MAY use the subject comments as subtle hints, but do not copy them verbatim or list them mechanically.
- Do NOT mention the scores numerically (do not say "7/10").
- Keep it one paragraph of 80–100 words.
- If there are no scores, write a general but realistic termly summary.

SUBJECT SCORES:
${scoreLines || "No explicit scores provided."}

SUBJECT COMMENTS (hints only):
${commentLines || "No specific subject comments."}

TEACHER NOTES (overall):
"${data.teacher_notes}"
`;

      const reportResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.6,
        messages: [{ role: "user", content: reportPrompt }]
      });

      const reportText = (reportResp.choices?.[0]?.message?.content || "").trim();

      // Generate PDF
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([595, 842]);
      const { width, height } = page.getSize();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      // Logo
      try {
        const logoBytes = (await axios.get(LOGO_URL, { responseType: "arraybuffer" })).data;
        const logoImage = await pdfDoc.embedJpg(logoBytes);
        const logoDims = logoImage.scale(0.2);

        page.drawImage(logoImage, {
          x: 408,
          y: 690,
          width: logoDims.width,
          height: logoDims.height
        });
      } catch (err) {
        console.log("Logo failed:", err.message);
      }

      // Address block
      page.drawText("Church Ln,",     { x: 432, y: 667, size: 11, font });
      page.drawText("Bury,",          { x: 432, y: 649, size: 11, font });
      page.drawText("Pulborough,",    { x: 432, y: 631, size: 11, font });
      page.drawText("RH20 1PB",       { x: 432, y: 613, size: 11, font, color: rgb(0,0.3,0.6) });

      // Greeting
      page.drawText("Dear Parent,", {
        x: 70, y: 624, size: 13, font: bold
      });
      page.drawText("Please find below the latest report for your child.", {
        x: 70, y: 594, size: 11, font
      });

      // Table
      const left = 70;
      const col1 = 70;
      const col2 = 260;
      const col3 = 380;
      const tableTop = 531;

      page.drawRectangle({
        x: left, y: tableTop + 5, width: 455, height: 30,
        color: rgb(0.05, 0.25, 0.5)
      });

      page.drawText("Subject",  { x: col1 + 10, y: tableTop + 12, size: 12, font: bold, color: rgb(1,1,1) });
      page.drawText("Score",    { x: col2 + 10, y: tableTop + 12, size: 12, font: bold, color: rgb(1,1,1) });
      page.drawText("Comments", { x: col3 + 10, y: tableTop + 12, size: 12, font: bold, color: rgb(1,1,1) });

      [col2, col3].forEach(col => {
        page.drawLine({
          start: { x: col, y: tableTop + 35 },
          end:   { x: col, y: tableTop - 200 },
          thickness: 0.5,
          color: rgb(0.7,0.7,0.7)
        });
      });

      const scoreSubjects = Object.keys(data.scores || {});
      const commentSubjects = Object.keys(data.subject_comments || {});
      const subjectSet = new Set([...scoreSubjects, ...commentSubjects]);
      const allSubjects = Array.from(subjectSet);

      let y = tableTop - 40;

      for (const subject of allSubjects) {
        y -= 30;

        const level = data.scores?.[subject];
        const comment = data.subject_comments?.[subject] || "";

        page.drawText(subject, { x: col1 + 10, y, size: 11, font });

        if (level !== undefined && level !== null && level !== "") {
          page.drawText(level.toString(), { x: col2 + 10, y, size: 11, font });
        }

        if (comment) {
          page.drawText(comment, { x: col3 + 10, y, size: 11, font });
        }

        page.drawLine({
          start: { x: left, y: y - 5 },
          end:   { x: left + 455, y: y - 5 },
          thickness: 0.5,
          color: rgb(0.85,0.85,0.85)
        });
      }

      // Longer Comments
      y -= 50;
      page.drawText("Longer comments", { x: 70, y, size: 13, font: bold });

      const lines = reportText.match(/.{1,92}(\s|$)/g) || [reportText || ""];

      let textY = y - 20;
      lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        page.drawText(trimmed, { x: 70, y: textY, size: 11, font });
        textY -= 20;
      });

      const pdfBytes = await pdfDoc.save();
      allPDFs.push({
        name: data.student_name,
        bytes: pdfBytes
      });
    }

    // Return first PDF (or combine if multiple)
    if (allPDFs.length === 0) {
      return res.status(400).json({ error: 'No valid students found' });
    }

    // For single student, return PDF directly
    if (allPDFs.length === 1) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${allPDFs[0].name.replace(/[^a-zA-Z0-9]/g, '_')}_report.pdf"`);
      return res.send(Buffer.from(allPDFs[0].bytes));
    }

    // For multiple students, return first one (Shortcuts can only handle one response)
    // User would need to record separate voice notes for multiple students
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${allPDFs[0].name.replace(/[^a-zA-Z0-9]/g, '_')}_report.pdf"`);
    return res.send(Buffer.from(allPDFs[0].bytes));

  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
};
