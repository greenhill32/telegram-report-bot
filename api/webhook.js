const OpenAI = require('openai');
const axios = require('axios');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Helper: Send text message
async function sendMessage(chatId, text, options = {}) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    ...options
  });
}

// Helper: Download voice file
async function downloadVoiceFile(fileId) {
  const fileResponse = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = fileResponse.data.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  const audioResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  return Buffer.from(audioResponse.data);
}

// MAIN HANDLER
module.exports = async (req, res) => {
  if (req.method === "GET") {
    return res.status(200).json({ status: "Bot is running!" });
  }

  if (req.method === "POST") {
    try {
      const update = req.body;

      // /start
      if (update.message?.text === "/start" || update.message?.text === "/help") {
        await sendMessage(
          update.message.chat.id,
          `Welcome to Report Bot!

Send a voice note like:
"Harry Ramsden. English 5, Maths 7, PE 6. Lovely to teach.
NEXT STUDENT
Lisa Simpson. English 9, Maths 9, PE 2. Hates rugby."

You’ll get one beautiful PDF per student.`,
          { parse_mode: "Markdown" }
        );
        return res.status(200).json({ ok: true });
      }

      // Only accept voice notes
      if (!update.message?.voice) {
        await sendMessage(update.message.chat.id, "Please send a voice note.");
        return res.status(200).json({ ok: true });
      }

      const chatId = update.message.chat.id;
      const fileId = update.message.voice.file_id;

      await sendMessage(chatId, "Processing your voice note...");

      // 1. Download + transcribe
      const audioBuffer = await downloadVoiceFile(fileId);
      const audioFile = new File([audioBuffer], "voice.ogg", { type: "audio/ogg" });

      const transcription = await openai.audio.transcriptions.create({
        file: audioFile,
        model: "whisper-1",
        language: "en"
      });

      const transcript = transcription.text.toLowerCase();
      const segments = transcript.split("next student").map(s => s.trim()).filter(s => s.length > 0);

      await sendMessage(chatId, `Found ${segments.length} student(s). Generating PDFs...`);

      // 2. Process each student
      for (let i = 0; i < segments.length; i++) {
        const studentText = segments[i];

        // Parse with GPT
        const parseResponse = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0,
          messages: [{
            role: "user",
            content: `Return ONLY valid JSON from this voice note:\n"${studentText}"\n\n{
  "student_name": "Full Name",
  "scores": { "English": 5, "Maths": 7, "PE": 6, "Science": null },
  "teacher_notes": "any extra notes"
}`
          }]
        });

        let parsedData;
        try {
          const jsonStr = parseResponse.choices[0].message.content.replace(/```json|```/g, "").trim();
          parsedData = JSON.parse(jsonStr);
        } catch (e) {
          await sendMessage(chatId, `Could not parse student ${i + 1}. Skipping.`);
          continue;
        }

        // Generate full report text
        const reportResponse = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.7,
          messages: [{
            role: "user",
            content: `Write a warm, professional 120–150 word British school report for ${parsedData.student_name}.\nScores:\n${Object.entries(parsedData.scores)
              .filter(([_, v]) => v !== null)
              .map(([s, v]) => `- ${s}: ${v}/10`)
              .join("\n") || "No scores given"}\nTeacher notes: "${parsedData.teacher_notes}"`
          }]
        });

        const reportText = reportResponse.choices[0].message.content.trim();

        // ————— CREATE PDF —————
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([595, 842]); // A4
        const { height } = page.getSize();
        const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

        let y = height - 50;

        // Title & name
        page.drawText("Student Report", { x: 50, y, size: 28, font: bold, color: rgb(0, 0.3, 0.6) });
        y -= 50;
        page.drawText(parsedData.student_name, { x: 50, y, size: 22, font: bold });

        // Scores table
        y -= 60;
        page.drawText("Subject", { x: 50, y, size: 14, font: bold, color: rgb(1,1,1) });
        page.drawText("Level", { x: 280, y, size: 14, font: bold, color: rgb(1,1,1) });
        page.drawRectangle({ x: 45, y: y - 10, width: 505, height: 30, color: rgb(0, 0.3, 0.6) });

        y -= 50;
        for (const [subject, level] of Object.entries(parsedData.scores)) {
          if (level === null) continue;
          page.drawText(subject, { x: 50, y, size: 12, font: helvetica });
          page.drawText(level.toString(), { x: 290, y, size: 12, font: helvetica });
          y -= 35;
        }

        // Full report
        y -= 30;
        page.drawText("Teacher Comment", { x: 50, y, size: 14, font: bold });
        y -= 30;
        const lines = reportText.match(/.{1,85}(\s|$)/g) || [reportText];
        lines.forEach(line => {
          page.drawText(line.trim(), { x: 50, y, size: 12, font: helvetica });
          y -= 20;
        });

        // Save & send
        const pdfBytes = await pdfDoc.save();
        const safeName = parsedData.student_name.replace(/[^a-zA-Z0-9]/g, "_");
        const filename = `${safeName}_report.pdf`;
        const tmpPath = path.join("/tmp", filename);
        fs.writeFileSync(tmpPath, pdfBytes);

        await axios.post(`${TELEGRAM_API}/sendDocument`, {
          chat_id: chatId,
          document: {
            value: fs.createReadStream(tmpPath),
            options: { filename, contentType: "application/pdf" }
          },
          caption: `Report for ${parsedData.student_name}`
        });

        fs.unlinkSync(tmpPath);
      }

      await sendMessage(chatId, "All reports sent as PDFs!");

      return res.status(200).json({ ok: true });

    } catch (err) {
      console.error("Error:", err);
      if (req.body.message?.chat?.id) {
        await sendMessage(req.body.message.chat.id, `Error: ${err.message}`);
      }
      return res.status(200).json({ ok: false });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
};
