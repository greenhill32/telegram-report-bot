// Dorset House Report Bot - FINAL WORKING VERSION
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

      // Parse structured data
      const parseResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [{
          role: "user",
          content: `Extract data as valid JSON for: "${studentText}"
Return ONLY JSON like:
{
  "student_name": "Full Name",
  "scores": { "English": 5, "Maths": 7, "PE": 10, "Science": null },
  "teacher_notes": "additional notes"
}`
        }]
      });

      let data;
      try {
        const json = parseResp.choices[0].message.content.replace(/```json|```/g, "").trim();
        data = JSON.parse(json);
      } catch {
        await sendMessage(chatId, `Could not parse student ${i + 1}.`);
        continue;
      }

      // Generate written report
      const reportResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.6,
        messages: [{
          role: "user",
          content:
`Write an 80â€“110 word warm British school report for ${data.student_name}.
Scores:
${Object.entries(data.scores).filter(([_,v])=>v!==null).map(([s,v]) => `- ${s}: ${v}/10`).join("\n")}
Notes: "${data.teacher_notes || ""}"`
        }]
      });

      const reportText = reportResp.choices[0].message.content.trim();

      // ---------------------------
      // PDF GENERATION
      // ---------------------------
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([595, 842]);
      const { width, height } = page.getSize();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      // ----------------------------------------------------------
      // LOGO FIX â€” ALWAYS WORKS (no fs, no local files)
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
      // PERFECT TABLE (FIXED)
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

      // Draw column lines
      [col2, col3].forEach(col => {
        page.drawLine({
          start: { x: col, y: tableTop + 35 },
          end: { x: col, y: tableTop - 200 },
          thickness: 0.5,
          color: rgb(0.7,0.7,0.7)
        });
      });

      // Row drawing loop â€” FIXED
      let y = tableTop - 30;

      for (const [subject, level] of Object.entries(data.scores)) {
        if (level === null) continue;

        y -= 30;

        page.drawText(subject, { x: col1 + 10, y, size: 11, font });
        page.drawText(level.toString(), { x: col2 + 10, y, size: 11, font });
        page.drawText("", { x: col3 + 10, y, size: 11, font }); // keeps column aligned

        page.drawLine({
          start: { x: left, y: y - 5 },
          end: { x: left + 455, y: y - 5 },
          thickness: 0.5,
          color: rgb(0.85,0.85,0.85)
        });
      }

      // Longer Comments
      y -= 50;
      page.drawText("Longer comments", { x: 70, y, size: 13, font: bold });

      const lines = reportText.match(/.{1,92}(\s|$)/g) || [reportText];
      let textY = y - 20;

      lines.forEach(line => {
        page.drawText(line.trim(), { x: 70, y: textY, size: 11, font });
        textY -= 20;
      });

      // -------------------
      // SEND PDF
      // -------------------
      const pdfBytes = await pdfDoc.save();
      const safeName = data.student_name.replace(/[^a-zA-Z0-9]/g, "_");
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
