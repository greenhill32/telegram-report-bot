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

// Helper: send text
async function sendMessage(chatId, text, options = {}) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    ...options
  });
}

// Helper: download voice
async function downloadVoiceFile(fileId) {
  const fileResponse = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = fileResponse.data.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  const audioResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  return Buffer.from(audioResponse.data);
}

module.exports = async (req, res) => {
  if (req.method === "GET") return res.status(200).json({ status: "Bot is alive!" });

  try {
    const update = req.body;

    if (update.message?.text === "/start" || update.message?.text === "/help") {
      await sendMessage(update.message.chat.id, `Welcome to Report Bot!

Send a voice note like:
"Harry Ramsden. English 5, Maths 7, PE 6. Lovely kid.
NEXT STUDENT
Lisa Simpson. English 9, Maths 9, PE 2. Hates rugby."

You’ll get one beautiful PDF per student.`);
      return res.status(200).send("ok");
    }

    if (!update.message?.voice) {
      await sendMessage(update.message.chat.id, "Please send a voice note.");
      return res.status(200).send("ok");
    }

    const chatId = update.message.chat.id;
    const fileId = update.message.voice.file_id;

    await sendMessage(chatId, "Transcribing and generating PDFs...");

    // 1. Transcribe
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

    await sendMessage(chatId, `Found ${segments.length} student(s). Creating PDFs...`);

    // 2. Process each student
    for (let i = 0; i < segments.length; i++) {
      const studentText = segments[i];

      // Parse JSON
      const parseResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [{ role: "user", content: `Return ONLY valid JSON:\n"${studentText}"\n\n{
  "student_name": "Full Name",
  "scores": { "English": 5, "Maths": 7, "PE": 6, "Science": null },
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

      // Generate report text
      const reportResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.7,
        messages: [{ role: "user", content: `Write a warm, professional 120–150 word British school report for ${data.student_name}.
Scores:\n${Object.entries(data.scores).filter(([_,v])=>v!==null).map(([s,v])=>`- ${s}: ${v}/10`).join("\n") || "No scores"}
Notes: "${data.teacher_notes || ""}"`}]
      });
      const reportText = reportResp.choices[0].message.content.trim();

              // ——— EXACTLY YOUR SCHOOL LETTER FORMAT ———
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([595, 842]); // A4
        const { width, height } = page.getSize();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

        // School crest top-right
        if (fs.existsSync("logo.png")) {
          const logoBytes = fs.readFileSync("logo.png");
          const logo = await pdfDoc.embedPng(logoBytes);
          page.drawImage(logo, { x: width - 150, y: height - 130, width: 100, height: 100 });
        }

        // Letterhead
        let y = height - 160;
        page.drawText("Church Ln,", { x: 380, y: y, size: 11, font }); y -= 18;
        page.drawText("Bury,", { x: 380, y, size: 11, font }); y -= 18;
        page.drawText("Pulborough,", { x: 380, y, size: 11, font }); y -= 18;
        page.drawText("RH20 1PB", { x: 380, y, size: 11, font, color: rgb(0,0.4,0.8) });

        y -= 50;
        page.drawText("Dear Parent,", { x: 50, y, size: 12, font });

        y -= 40;
        page.drawText("some pre-amble", { x: 50, y, size: 11, font });

        // Table
        y -= 40;
        const drawLine = (yPos) => page.drawLine({ start: { x: 50, y: yPos }, end: { x: 545, y: yPos }, thickness: 1, color: rgb(0,0,0) });

        drawLine(y); // top
        page.drawText("Subject", { x: 60, y: y - 20, size: 12, font: bold });
        page.drawText("score", { x: 260, y: y - 20, size: 12, font: bold });
        page.drawText("Comments", { x: 360, y: y - 20, size: 12, font: bold });
        drawLine(y - 30);

        y -= 60;
        for (const [subject, level] of Object.entries(data.scores)) {
          if (level === null) continue;
          page.drawText(subject, { x: 60, y, size: 11, font });
          page.drawText(level.toString(), { x: 270, y, size: 11, font });
          y -= 30;
        }
        drawLine(y + 30); // bottom

        // Longer comments
        y -= 50;
        page.drawText("Longer comments", { x: 50, y, size: 12, font: bold });
        y -= 30;
        const commentLines = reportText.match(/.{1,90}(\s|$)/g) || [];
        commentLines.forEach(line => {
          page.drawText(line.trim(), { x: 50, y, size: 11, font });
          y -= 20;
        });

        // Save & send (same as before)
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

    await sendMessage(chatId, "All PDFs sent successfully!");

  } catch (err) {
    console.error(err);
    if (req.body.message?.chat?.id) {
      await sendMessage(req.body.message.chat.id, `Error: ${err.message}`);
    }
  }

  res.status(200).send("ok");
};
