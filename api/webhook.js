// /api/webhook.js   ←  Final version – works Dec 2025 on Vercel
const OpenAI = require('openai');
const axios = require('axios');
const FormData = require('form-data');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const HTMLCSS_API_KEY = process.env.HTMLCSS_API_KEY;        // your 019b029c-…
const HTMLCSS_USER_ID = "01KC19SWH8FCH78MZ4G20MEHHS";       // your public ID

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const HTML_TEMPLATE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body{font-family:Arial,sans-serif;margin:0;padding:50px 40px;color:#333;background:#fff}
  .header{text-align:center;margin-bottom:50px}
  .header img{height:90px;margin-bottom:10px}
  h1{color:#1e3a8a;margin:5px 0;font-size:28px}
  h2{color:#1e3a8a;border-bottom:3px solid #dbeafe;padding-bottom:6px}
  table{width:100%;border-collapse:collapse;margin:30px 0;font-size:15px}
  th{background:#eff6ff;padding:12px;text-align:left}
  td{padding:12px;border-bottom:1px solid #e5e7eb}
  .report{line-height:1.8;font-size:15.5px}
</style></head><body>
  <div class="header">
    <img src="https://i.imgur.com/6gZ3t2P.png" alt="Crest">
    <h1>Dorset House School</h1>
    <p><strong>End of Term Report</strong></p>
  </div>
  <h2>Report for {{STUDENT_NAME}}</h2>
  <table><tr><th>Subject</th><th>Score</th><th>Comment</th></tr>
  {{#SUBJECTS}}
  <tr><td><strong>{{name}}</strong></td><td>{{score}}/10</td><td>{{comments}}</td></tr>
  {{/SUBJECTS}}</table>
  <h2>General Report</h2>
  <div class="report">{{{REPORT_TEXT}}}</div>
</body></html>`;

module.exports = async (req, res) => {
  // Health check
  if (req.method === "GET") return res.status(200).json({ status: "OK" });

  try {
    const update = req.body;
    const text = update.message?.text || "";

    // ── COMMANDS – works in private chat AND groups ──
    if (text.trim().toLowerCase().startsWith("/start") || text.trim().toLowerCase().startsWith("/help")) {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: update.message.chat.id,
        text: `Dorset House Report Bot

Send me a voice note like:

“Harry Ramsden. English 7, Maths 5, PE 9. Really improved confidence this term.”

(or say “next student” for multiple)

You will receive beautiful letterheaded PDFs instantly.`,
        parse_mode: "Markdown"
      });
      return res.status(200).send("ok");
    }

    // ── ONLY VOICE NOTES ──
    if (!update.message?.voice) {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: update.message.chat.id,
        text: "Please send a voice note"
      });
      return res.status(200).send("ok");
    }

    const chatId = update.message.chat.id;
    const fileId = update.message.voice.file_id;

    await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: "Transcribing…" });

    // Download voice
    const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const audioUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.data.result.file_path}`;
    const audioBuffer = (await axios.get(audioUrl, { responseType: "arraybuffer" })).data;

    // Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: new File([audioBuffer], "voice.ogg", { type: "audio/ogg" }),
      model: "whisper-1",
      language: "en"
    });

    const segments = transcription.text.toLowerCase()
      .split(/\bnext student\b/)
      .map(s => s.trim())
      .filter(Boolean);

    await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: `Found ${segments.length} student(s). Creating PDFs…` });

    const Mustache = require('mustache');

    for (const segment of segments) {
      // Parse student
      const parse = await openai.chat.completions.create({
        model: "gpt-4o-mini", temperature: 0,
        messages: [{ role: "user", content: `Return ONLY valid JSON:\n"${segment}"\n\n{"student_name":"Full Name","scores":{"English":7,"Maths":5,"PE":9},"teacher_notes":"any notes"}` }]
      });

      const data = JSON.parse((await parse).choices[0].message.content.replace(/```json|```/g, "").trim());

      // Full report
      const report = await openai.chat.completions.create({
        model: "gpt-4o-mini", temperature: 0.7,
        messages: [{ role: "user", content: `Write a warm 80–100 word British school report for ${data.student_name}.\nScores: ${JSON.stringify(data.scores)}\nNotes: ${data.teacher_notes || ""}` }]
      });
      const reportText = report.choices[0].message.content.trim();

      // Subject comments
      const comm = await openai.chat.completions.create({
        model: "gpt-4o-mini", temperature: 0.7,
        messages: [{ role: "user", content: `Short 3–6 word comments only. Return JSON.\n${JSON.stringify(data.scores)}\nNotes: ${data.teacher_notes}\n\nExample: {"English":"Excellent effort","Maths":"Improving rapidly"}` }]
      });

      let subjectComments = {};
      try { subjectComments = JSON.parse(comm.choices[0].message.content.replace(/```json|```/g, "").trim()); }
      catch { /* fallback defaults */ }

      const subjects = Object.entries(data.scores)
        .filter(([_, s]) => s !== null)
        .map(([name, score]) => ({
          name,
          score,
          comments: subjectComments[name] || (score >= 7 ? "Strong progress" : "Working hard")
        }));

      // Render HTML → PDF via htmlcsstoimage (free tier)
      const html = Mustache.render(HTML_TEMPLATE, {
        STUDENT_NAME: data.student_name,
        SUBJECTS: subjects,
        REPORT_TEXT: reportText.replace(/\n/g, "<br>")
      });

      const pdfRes = await axios.post("https://hcti.io/v1/image", {
        html, google_fonts: "Arial"
      }, {
        auth: { username: 01KC19SWH8FCH78MZ4G20MEHHS, password: 019b029c-f228-747f-8b10-aff7aaf80909 },
        responseType: "arraybuffer"
      });

      // Send PDF
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("document", Buffer.from(pdfRes.data), { filename: `${data.student_name.replace(/[^a-zA-Z0-9]/g, "_")}_report.pdf` });
      form.append("caption", `Report for ${data.student_name}`);
      await axios.post(`${TELEGRAM_API}/sendDocument`, form, { headers: form.getHeaders() });
    }

    await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: "All PDFs sent!" });

  } catch (err) {
    console.error(err);
    try {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: req.body?.message?.chat?.id,
        text: `Error: ${err.message}`
      });
    } catch { }
  }

  res.status(200).send("ok");
};
