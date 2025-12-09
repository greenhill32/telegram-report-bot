///
// Dorset House Report Bot - FINAL WORKING VERSION (HARDENED PARSER + COMMENTS IN TABLE)
const OpenAI = require('openai');
const axios = require('axios');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const path = require('path');
const FormData = require('form-data');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const LOGO_URL = "https://publicbucket3222.blob.core.windows.net/$web/report/logo.jpg";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function sendMessage(chatId, text, options = {}) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text, ...options });
}

async function downloadVoiceFile(fileId) {
  const fileResponse = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = fileResponse.data.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  const audioResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  return Buffer.from(audioResponse.data);
}

// Normalise subject names a bit, without being too strict
function normaliseSubjectName(raw) {
  if (!raw || typeof raw !== "string") return "Subject";
  const s = raw.trim().toLowerCase();

  if (["english", "eng"].includes(s)) return "English";
  if (["math", "maths", "mathematics"].includes(s)) return "Maths";
  if (["science"].includes(s)) return "Science";
  if (["pe", "p.e", "p.e.", "physical education"].includes(s)) return "PE";
  if (["reading"].includes(s)) return "Reading";
  if (["writing"].includes(s)) return "Writing";

  // Fallback: capitalise first letter of each word
  return raw
    .split(" ")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Clean up comment text, handling #no_comment# etc.
function normaliseCommentText(raw) {
  if (!raw || typeof raw !== "string") return "";
  const lower = raw.toLowerCase();
  if (lower.includes("#no_comment#") || lower.includes("no comment")) {
    return "";
  }
  return raw.trim();
}

module.exports = async (req, res) => {
  if (req.method === "GET") {
    return res.status(200).json({ status: "Bot running" });
  }

  try {
    const update = req.body;

    // *******************************
    // /start and /help MUST WORK
    // *******************************
    if (update?.message?.text === "/start" || update?.message?.text === "/help") {
      await sendMessage(update.message.chat.id,
`Dorset House Report Bot

Send a voice note such as:
"Harry Ramsden. English 5, Maths 7, PE 10. Great term.
NEXT STUDENT
Lisa Simpson. English 9, Maths 9, PE 2. Hates rugby."

You will receive beautifully formatted letterheaded PDFs.`);
      return res.status(200).send("ok");
    }

    if (!update?.message?.voice) {
      await sendMessage(update.message.chat.id, "Please send a voice note.");
      return res.status(200).send("ok");
    }

    const chatId = update.message.chat.id;
    const fileId = update.message.voice.file_id;

    await sendMessage(chatId, "Transcribing and preparing reports...");

    // Whisper transcription
    const audioBuffer = await downloadVoiceFile(fileId);
    const audioFile = new File([audioBuffer], "voice.ogg", { type: "audio/ogg" });

    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      language: "en"
    });

    // Split students
    const segments = transcription.text
      .toLowerCase()
      .split("next student")
      .map(s => s.trim())
      .filter(s => s.length > 0);

    await sendMessage(chatId, `Processing ${segments.length} student(s)...`);

    // PROCESS EACH STUDENT
    for (let i = 0; i < segments.length; i++) {
      const studentText = segments[i];

      // ---------------------------
      // SMART, HARDENED PARSER WITH COMMENTS + TEACHER NOTES BOUNDARY
      // ---------------------------
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
- A subject may have:
  - a score only,
  - a comment only,
  - a score and a comment,
  - or neither (then do not include it).
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
        messages: [{
          role: "user",
          content: parsePrompt
        }]
      });

      let data;
      try {
        let jsonText = parseResp.choices?.[0]?.message?.content || "";
        jsonText = jsonText.replace(/```json|```/gi, "").trim();
        if (!jsonText) {
          await sendMessage(chatId, `Could not parse student ${i + 1} (empty response).`);
          continue;
        }

        data = JSON.parse(jsonText);
      } catch (e) {
        console.error("JSON parse error for student", i + 1, e);
        await sendMessage(chatId, `Could not parse student ${i + 1}.`);
        continue;
      }

      // ---------------------------
      // HARDEN DATA STRUCTURE
      // ---------------------------
      if (!data || typeof data !== "object") {
        await sendMessage(chatId, `Invalid data for student ${i + 1}.`);
        continue;
      }

      // Ensure student_name
      if (!data.student_name || typeof data.student_name !== "string") {
        data.student_name = `Student ${i + 1}`;
      }

      // Ensure teacher_notes
      if (typeof data.teacher_notes !== "string") {
        data.teacher_notes = "";
      }

      // Ensure scores is an object and clean it
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

      // Ensure subject_comments is an object and clean it
      const rawSubjectComments = (data.subject_comments && typeof data.subject_comments === "object")
        ? data.subject_comments
        : {};
      const cleanedSubjectComments = {};

      for (const [rawSubject, rawComment] of Object.entries(rawSubjectComments)) {
        const subject = normaliseSubjectName(rawSubject);
        const commentText = normaliseCommentText(rawComment);
        cleanedSubjectComments[subject] = commentText;
      }

      // Ensure every subject with a score at least has a comment key
      for (const subject of Object.keys(data.scores)) {
        if (!(subject in cleanedSubjectComments)) {
          cleanedSubjectComments[subject] = "";
        }
      }

      data.subject_comments = cleanedSubjectComments;

      // Final safety nets
      if (!data.scores || typeof data.scores !== "object") {
        data.scores = {};
      }
      if (!data.subject_comments || typeof data.subject_comments !== "object") {
        data.subject_comments = {};
      }

      // ---------------------------
      // Generate written report (Tone #2 - Casual but Respectful)
      // ---------------------------
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
        messages: [{
          role: "user",
          content: reportPrompt
        }]
      });

      const reportText = (reportResp.choices?.[0]?.message?.content || "").trim();


      // ---------------------------
      // PDF GENERATION
      // ---------------------------
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([595, 842]);
      const { width, height } = page.getSize();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      // ----------------------------------------------------------
      // LOGO (via Azure Blob URL – no local files)
      // ----------------------------------------------------------
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

      // ------------------------
      // TABLE (Subjects, Scores, Comments)
      // ------------------------
      const left = 70;
      const col1 = 70;
      const col2 = 260;
      const col3 = 380;
      const tableTop = 531;

      // Header box
      page.drawRectangle({
        x: left, y: tableTop + 5, width: 455, height: 30,
        color: rgb(0.05, 0.25, 0.5)
      });

      page.drawText("Subject",  { x: col1 + 10, y: tableTop + 12, size: 12, font: bold, color: rgb(1,1,1) });
      page.drawText("Score",    { x: col2 + 10, y: tableTop + 12, size: 12, font: bold, color: rgb(1,1,1) });
      page.drawText("Comments", { x: col3 + 10, y: tableTop + 12, size: 12, font: bold, color: rgb(1,1,1) });

      // Column lines
      [col2, col3].forEach(col => {
        page.drawLine({
          start: { x: col, y: tableTop + 35 },
          end:   { x: col, y: tableTop - 200 },
          thickness: 0.5,
          color: rgb(0.7,0.7,0.7)
        });
      });

      // Build unified subject list (scores + comments)
      const scoreSubjects = Object.keys(data.scores || {});
      const commentSubjects = Object.keys(data.subject_comments || {});
      const subjectSet = new Set([...scoreSubjects, ...commentSubjects]);
      const allSubjects = Array.from(subjectSet);

      // Row drawing loop (hardened)
      let y = tableTop - 40; // small gap under header

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
      y -= 80;
      page.drawText("Teachers comments", { x: 70, y, size: 13, font: bold });

      const lines = reportText.match(/.{1,92}(\s|$)/g) || [reportText || ""];

      let textY = y - 20;
      lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        page.drawText(trimmed, { x: 70, y: textY, size: 11, font });
        textY -= 20;
      });

      // -------------------
      // SEND PDF
      // -------------------
      const pdfBytes = await pdfDoc.save();
      const safeName = data.student_name.replace(/[^a-zA-Z0-9]/g, "_") || `Student_${i + 1}`;
      const filename = `${safeName}_report.pdf`;
      const tmpPath = `/tmp/${filename}`;

      require('fs').writeFileSync(tmpPath, pdfBytes);

      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("document", require('fs').createReadStream(tmpPath), { filename });
      form.append("caption", `Report for ${data.student_name}`);

      await axios.post(`${TELEGRAM_API}/sendDocument`, form, {
        headers: form.getHeaders()
      });
    }

    await sendMessage(chatId, "All reports sent!");

  } catch (err) {
    console.error(err);
    if (req.body?.message?.chat?.id) {
      await sendMessage(req.body.message.chat.id, "Error: " + err.message);
    }
  }

  res.status(200).send("ok");
};
