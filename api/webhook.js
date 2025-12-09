// /api/webhook.js
const OpenAI = require('openai');
const axios = require('axios');
const FormData = require('form-data');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const HTMLCSS_API_KEY = process.env.HTMLCSS_API_KEY; // ← your key (019b029c-...)

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// === EMBEDDED HTML TEMPLATE (no files needed) ===
const HTML_TEMPLATE = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Report</title>
  <style>
    body { font-family: "Arial", sans-serif; margin: 0; padding: 50px 40px; color: #333; background: #fff; }
    .header { text-align: center; margin-bottom: 40px; }
    .header img { height: 90px; margin-bottom: 10px; }
    h1 { color: #1e3a8a; margin: 8px 0; font-size: 28px; }
    .subtitle { font-size: 18px; color: #444; margin-bottom: 30px; }
    h2 { color: #1e3a8a; border-bottom: 3px solid #dbeafe; padding-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; margin: 30px 0; font-size: 15px; }
    th { background: #eff6ff; text-align: left; padding: 12px; }
    td { padding: 12px; border-bottom: 1px solid #e5e7eb; }
    .report { line-height: 1.8; font-size: 15.point5px; }
  </style>
</head>
<body>
  <div class="header">
    <img src="https://i.imgur.com/REPLACE_WITH_YOUR_LOGO_IF_YOU_WANT.png" alt="Crest">
    <h1>Dorset House School</h1>
    <div class="subtitle"><strong>End of Term Report</strong></div>
  </div>

  <h2>Report for {{STUDENT_NAME}}</h2>

  <table>
    <tr><th>Subject</th><th>Score</th><th>Teacher Comment</th></tr>
    {{#SUBJECTS}}
    <tr>
      <td><strong>{{name}}</strong></td>
      <td>{{score}}/10</td>
      <td>{{comments}}</td>
    </tr>
    {{/SUBJECTS}}
  </table>

  <h2>General Report</h2>
  <div class="report">{{{REPORT_TEXT}}}</div>
</body>
</html>`;

module.exports = async (req, res) => {
  if (req.method === "GET") return res.status(200).json({ status: "Bot running – Dec 2025" });

  try {
    const update = req.body;
    const text = update.message?.text?.trim() || "";

    // /start & /help – works in groups too
    if (text.startsWith("/start") || text.startsWith("/help")) {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: update.message.chat.id,
        text: `Dorset House Report Bot

Send a voice note like:
"Harry Ramsden. English 7, Maths 5, PE 9. Really improved confidence this term."
(or say NEXT STUDENT for more)

You’ll receive beautiful letterheaded PDFs instantly.`,
        parse_mode: "Markdown"
      });
      return res.status(200).send("ok");
    }

    if (!update.message?.voice) {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: update.message.chat.id,
        text: "Please send a voice note"
      });
      return res.status(200).send("ok");
    }

    const chatId = update.message.chat.id;
    const fileId = update.message.voice.file_id;

    await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: "Transcribing and creating your reports..." });

    // Download voice → Whisper
    const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const filePath = fileRes.data.result.file_path;
    const audioUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
    const audioBuffer = (await axios.get(audioUrl, { responseType: "arraybuffer" })).data;
    const audioFile = new File([audioBuffer], "voice.ogg", { type: "audio/ogg" });

    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      language: "en"
    });

    const segments = transcription.text.toLowerCase()
      .split("next student")
      .map(s => s.trim())
      .filter(Boolean);

    await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: `Found ${segments.length} student(s). Generating PDFs...` });

    const Mustache = require('mustache');

    for (let i = 0; i < segments.length; i++) {
      const studentText = segments[i];

      // 1. Parse name/scores/notes
      const parse = await openai.chat.completions.create({
        model: "gpt-4o-mini", temperature: 0,
        messages: [{ role: "user", content: `Return ONLY valid JSON from this voice note:\n"${studentText}"\n\n{
  "student_name": "Full Name",
  "scores": { "English": 7, "Maths": 5, "PE": 9, "Science": null },
  "teacher_notes": "any extra comments"
}`} }]
      });

      let data;
      try {
        data = JSON.parse(parse.choices[0].message.content.replace(/```json|```/g, "").trim());
      } catch {
        await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: `Could not parse student ${i+1}` });
        continue;
      }

      // 2. Full report text
      const report = await openai.chat.completions.create({
        model: "gpt-4o-mini", temperature: 0.7,
        messages: [{ role: "user", content: `Write a warm, professional 80–100 word British school report for ${data.student_name}.\nScores: ${JSON.stringify(data.scores)}\nNotes: ${data.teacher_notes || "none"}` }]
      });
      const reportText = report.choices[0].message.content.trim();

      // 3. Short subject comments
      const comments = await openai.chat.completions.create({
        model: "gpt-4o-mini", temperature: 0.7,
        messages: [{ role: "user", content: `Return ONLY JSON with 3–6 word comments per subject.\n${JSON.stringify(data.scores)}\nNotes: ${data.teacher_notes}\n\nExample: {"English":"Excellent progress","Maths":"Working hard"}` }]
      });

      let subjectComments = {};
      try {
        subjectComments = JSON.parse(comments.choices[0].message.content.replace(/```json|```/g, "").trim());
      } catch {
        Object.keys(data.scores).forEach(k => {
          if (data.scores[k] !== null) subjectComments[k] = data.scores[k] >= 7 ? "Strong effort" : "Continuing to develop";
        });
      }

      const subjects = Object.entries(data.scores)
        .filter(([_, s]) => s !== null)
        .map(([name, score]) => ({
          name,
          score,
          comments: subjectComments[name] || "Progressing well"
        }));

      // 4. Render HTML + convert to PDF via htmlcsstoimage (free tier)
      const html = Mustache.render(HTML_TEMPLATE, {
        STUDENT_NAME: data.student_name,
        SUBJECTS: subjects,
        REPORT_TEXT: reportText.replace(/\n/g, "<br>")
      });

      const pdfResponse = await axios.post("https://hcti.io/v1/image", {
        html,
        css: "body { font-family: Arial; }",
        google_fonts: "Arial"
      }, {
        auth: { username: "01KC19SWH8FCH78MZ4G20MEHHS", password: 019b029c-f228-747f-8b10-aff7aaf80909 },
        responseType: "arraybuffer"
      });

      const pdfBuffer = Buffer.from(pdfResponse.data);

      // 5. Send PDF
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("document", pdfBuffer, { filename: `${data.student_name.replace(/[^a-zA-Z0-9]/g, "_")}_report.pdf` });
      form.append("caption", `Report for ${data.student_name}`);

      await axios.post(`${TELEGRAM_API}/sendDocument`, form, { headers: form.getHeaders() });
    }

    await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: "All beautiful PDFs sent!" });

  } catch (err) {
    console.error(err);
    try {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: req.body?.message?.chat?.id || chatId,
        text: `Error: ${err.message}`
      });
    } catch {}
  }

  res.status(200).send("ok");
};
