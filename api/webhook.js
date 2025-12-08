const OpenAI = require('openai');
const axios = require('axios');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function sanitizeText(text) {
  return text.replace(/['']/g, "'").replace(/[""]/g, '"').replace(/[—–]/g, "-").replace(/…/g, "...").replace(/[^\x00-\x7F]/g, "");
}

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
  if (req.method === "GET") return res.status(200).json({ status: "Bot is running!" });

  try {
    const update = req.body;

    if (update.message?.text === "/start" || update.message?.text === "/help") {
      await sendMessage(update.message.chat.id, `Dorset House Report Bot

Send a voice note like:
"Harry Ramsden. English 5, Maths 7, PE 10. Brilliant term.
NEXT STUDENT
Lisa Simpson. English 9, Maths 9, PE 2. Hates rugby."

You’ll receive beautiful letterheaded PDFs instantly.`);
      return res.status(200).send("ok");
    }

    if (!update.message?.voice) {
      await sendMessage(update.message.chat.id, "Please send a voice note.");
      return res.status(200).send("ok");
    }

    const chatId = update.message.chat.id;
    const fileId = update.message.voice.file_id;

    await sendMessage(chatId, "Transcribing and creating your reports...");

    const audioBuffer = await downloadVoiceFile(fileId);
    const audioFile = new File([audioBuffer], "voice.ogg", { type: "audio/ogg" });

    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      language: "en"
    });

    const segments = transcription.text.toLowerCase()
      .split("next student")
      .map(s => s.trim())
      .filter(s => s.length > 0);

    await sendMessage(chatId, `Found ${segments.length} student(s). Generating letterheaded PDFs...`);

    for (let i = 0; i < segments.length; i++) {
      const studentText = segments[i];

      // Parse with GPT
      const parseResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [{ role: "user", content: `Return ONLY valid JSON:\n"${studentText}"\n\n{
  "student_name": "Full Name",
  "scores": { "English": 5, "Maths": 7, "PE": 10, "Science": null },
  "teacher_notes": "any notes"
}`}]
      });

      let data;
      try {
        const json = parseResp.choices[0].message.content.replace(/```json|```/g, "").trim();
        data = JSON.parse(json);
      } catch (e) {
        await sendMessage(chatId, `Could not parse student ${i+1}.`);
        continue;
      }

      // Generate full report
      const reportResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.7,
        messages: [{ role: "user", content: `Write a warm, professional 80–100 word British school report. You're a young male teacher, cool not stuffy. Use correct pronouns (he/she/they) based on ${data.student_name}'s name.
Scores:\n${Object.entries(data.scores).filter(([_,v])=>v!==null).map(([s,v])=>`- ${s}: ${v}/10`).join("\n") || "No scores"}
Notes: "${data.teacher_notes || ""}"`}]
      });
      const reportText = sanitizeText(reportResp.choices[0].message.content.trim());

      // PROFESSIONAL DORSET HOUSE PDF
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([595, 842]);
      const { width, height } = page.getSize();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      // LOGO top-right (supports logo.jpg or logo.png)
      if (fs.existsSync("logo.jpg") || fs.existsSync("logo.png")) {
        const logoPath = fs.existsSync("logo.jpg") ? "logo.jpg" : "logo.png";
        const logoBytes = fs.readFileSync(logoPath);
        const logoImage = logoPath.endsWith('.jpg')
          ? await pdfDoc.embedJpg(logoBytes)
          : await pdfDoc.embedPng(logoBytes);
        const logoDims = logoImage.scale(0.4);
        page.drawImage(logoImage, {
          x: width - 180,
          y: height - 140,
          width: logoDims.width,
          height: logoDims.height,
        });
      }

      // Address block under logo
      let y = height - 100;
      page.drawText(sanitizeText("Church Ln,"), { x: width - 200, y: y -= 20, size: 11, font });
      page.drawText(sanitizeText("Bury,"), { x: width - 200, y: y -= 20, size: 11, font });
      page.drawText(sanitizeText("Pulborough,"), { x: width - 200, y: y -= 20, size: 11, font });
      page.drawText(sanitizeText("RH20 1PB"), { x: width - 200, y: y -= 25, size: 11, font, color: rgb(0, 0.3, 0.6) });

      // Dear Parent section
      page.drawText(sanitizeText("Dear Parent,"), { x: 70, y: height - 180, size: 12, font: bold });
      page.drawText(sanitizeText("Please find below the latest report for your child."), { x: 70, y: height - 220, size: 11, font });
      page.drawText(sanitizeText("We are very proud of their progress this term."), { x: 70, y: height - 245, size: 11, font });

      // Professional table
      const left = 70;
      const col1 = 70;
      const col2 = 280;
      const col3 = 380;
      const tableTop = height - 320;

      page.drawRectangle({ x: left, y: tableTop + 5, width: 455, height: 30, color: rgb(0.05, 0.25, 0.5) });
      page.drawText(sanitizeText("Subject"),   { x: col1 + 10, y: tableTop + 12, size: 12, font: bold, color: rgb(1,1,1) });
      page.drawText(sanitizeText("score"),     { x: col2 + 15, y: tableTop + 12, size: 12, font: bold, color: rgb(1,1,1) });
      page.drawText(sanitizeText("Comments"),  { x: col3 + 10, y: tableTop + 12, size: 12, font: bold, color: rgb(1,1,1) });

      page.drawLine({ start: {x: left, y: tableTop + 35}, end: {x: left + 455, y: tableTop + 35}, thickness: 1.5 });
      page.drawLine({ start: {x: left, y: tableTop}, end: {x: left + 455, y: tableTop}, thickness: 1.5 });

      [col2, col3].forEach(col => {
        page.drawLine({ start: {x: col, y: tableTop + 35}, end: {x: col, y: tableTop - 200}, thickness: 0.5, color: rgb(0.7,0.7,0.7) });
      });

      y = tableTop - 30;
      for (const [subject, level] of Object.entries(data.scores)) {
        if (level === null) continue;
        page.drawText(sanitizeText(subject), { x: col1 + 10, y: y -= 35, size: 11, font });
        page.drawText(sanitizeText(level.toString()), { x: col2 + 20, y: y + 35, size: 11, font });
        page.drawLine({ start: {x: left, y: y + 15}, end: {x: left + 455, y: y + 15}, thickness: 0.5, color: rgb(0.85,0.85,0.85) });
      }

      // Longer comments
      y -= 60;
      page.drawText(sanitizeText("Longer comments"), { x: 70, y: y -= 10, size: 13, font: bold });
      const lines = reportText.match(/.{1,92}(\s|$)/g) || [reportText];
      lines.forEach(line => {
        page.drawText(sanitizeText(line.trim()), { x: 70, y: y -= 22, size: 11, font });
      });

      // SEND PDF
      const pdfBytes = await pdfDoc.save();
      const safeName = data.student_name.replace(/[^a-zA-Z0-9]/g, "_");
      const filename = `${safeName}_report.pdf`;
      const tmpPath = `/tmp/${filename}`;
      fs.writeFileSync(tmpPath, pdfBytes);

      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('document', fs.createReadStream(tmpPath), { filename });
      form.append('caption', `Report for ${data.student_name}`);

      await axios.post(`${TELEGRAM_API}/sendDocument`, form, { headers: form.getHeaders() });
      fs.unlinkSync(tmpPath);
    }

    await sendMessage(chatId, "All reports sent as beautiful PDFs!");

  } catch (err) {
    console.error(err);
    if (req.body.message?.chat?.id) {
      await sendMessage(req.body.message.chat.id, `Error: ${err.message}`);
    }
  }

  res.status(200).send("ok");
};
