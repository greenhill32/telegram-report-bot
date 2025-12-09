const OpenAI = require('openai');
const axios = require('axios');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');
const FormData = require('form-data');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function sendMessage(chatId, text, options = {}) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    ...options
  });
}

async function downloadVoiceFile(fileId) {
  const fileResp = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileResp.data.result.file_path}`;
  const audioResp = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  return Buffer.from(audioResp.data);
}

module.exports = async (req, res) => {

  if (req.method === "GET") {
    return res.status(200).json({ status: "Bot is running!" });
  }

  if (req.method !== "POST") {
    return res.status(405).send("Only POST allowed.");
  }

  try {
    const update = req.body;

    // --------------------- /START COMMAND ------------------------
    if (update.message?.text === "/start") {
      await sendMessage(
        update.message.chat.id,
`👋 *Welcome to Report Bot!*

Send a *voice note* like:

"Harry Ramsden. English 5, Maths 7, PE 10. Brilliant term.
NEXT STUDENT
Lisa Simpson. English 9, Maths 9, PE 2. Hates rugby."

You will receive professional *PDF reports* with Dorset House branding.`,
        { parse_mode: "Markdown" }
      );
      return res.status(200).send("ok");
    }

    // --------------------- /HELP COMMAND -------------------------
    if (update.message?.text === "/help") {
      await sendMessage(
        update.message.chat.id,
`*How to structure a voice note:*

"[Name]. English 7, Maths 6. Great progress. NEXT STUDENT..."

You can talk naturally — the bot cleans it up automatically.`,
        { parse_mode: "Markdown" }
      );
      return res.status(200).send("ok");
    }

    // Block normal text
    if (update.message?.text && !update.message.text.startsWith("/")) {
      await sendMessage(update.message.chat.id, "Please send a *voice note*.", {
        parse_mode: "Markdown"
      });
      return res.status(200).send("ok");
    }

    // --------------------- HANDLE VOICE --------------------------
    if (update.message?.voice) {
      const chatId = update.message.chat.id;

      await sendMessage(chatId, "🎤 Transcribing your voice note...");

      const audio = await downloadVoiceFile(update.message.voice.file_id);
      const audioFile = new File([audio], "voice.ogg", { type: "audio/ogg" });

      // Whisper
      const transcription = await openai.audio.transcriptions.create({
        file: audioFile,
        model: "whisper-1",
        language: "en"
      });

      const segments = transcription.text
        .toLowerCase()
        .split("next student")
        .map(t => t.trim())
        .filter(t => t.length > 0);

      await sendMessage(chatId, `🧩 Found ${segments.length} student(s). Creating PDFs...`);

      // ------------------ PROCESS EACH STUDENT -------------------
      for (let i = 0; i < segments.length; i++) {
        const studentText = segments[i];
        await sendMessage(chatId, `✏️ Processing student ${i + 1}...`);

        // 1) Parse structured data
        const parseResp = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0,
          messages: [{
            role: "user",
            content:
`Extract JSON only from this:

"${studentText}"

{
  "student_name": "Full Name",
  "scores": { "English": 5, "Maths": 7, "Science": null, "PE": null },
  "teacher_notes": "short notes"
}`
          }]
        });

        let data;
        try {
          const clean = parseResp.choices[0].message.content.replace(/```json|```/g, "");
          data = JSON.parse(clean);
        } catch (e) {
          await sendMessage(chatId, `⚠️ Could not parse student ${i + 1}. Skipping.`);
          continue;
        }

        // 2) Generate written report
        const reportResp = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.7,
          messages: [{
            role: "user",
            content:
`Write an 80–100 word British school report for ${data.student_name}.
Tone: warm, professional, specific.
Scores:
${Object.entries(data.scores)
  .filter(([_,v]) => v !== null)
  .map(([s,v]) => `- ${s}: ${v}/10`)
  .join("\n")}
Notes: "${data.teacher_notes}"`
          }]
        });

        const reportText = reportResp.choices[0].message.content.trim();

        // ------------------ BUILD PDF ------------------------------
        const pdf = await PDFDocument.create();
        const page = pdf.addPage([595, 842]);
        const { width, height } = page.getSize();
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

        // Logo
        if (fs.existsSync("logo.jpg") || fs.existsSync("logo.png")) {
          const logoPath = fs.existsSync("logo.jpg") ? "logo.jpg" : "logo.png";
          const logoBytes = fs.readFileSync(logoPath);
          const logoImage = logoPath.endsWith(".jpg")
            ? await pdf.embedJpg(logoBytes)
            : await pdf.embedPng(logoBytes);
          const scaled = logoImage.scale(0.35);
          page.drawImage(logoImage, {
            x: width - 170,
            y: height - 140,
            width: scaled.width,
            height: scaled.height
          });
        }

        // Address block
        let y = height - 110;
        ["Church Ln,", "Bury,", "Pulborough,", "RH20 1PB"].forEach(line => {
          page.drawText(line, { x: width - 200, y, size: 11, font });
          y -= 18;
        });

        // Intro text
        page.drawText("Dear Parent,", { x: 70, y: height - 180, size: 12, font: bold });
        page.drawText("Please find your child’s latest termly report below.", { x: 70, y: height - 210, size: 11, font });

        // -------- Table Header --------
        const left = 70;
        const colSubject = left + 10;
        const colScore = left + 200;
        const colComment = left + 280;
        const tableTop = height - 280;

        page.drawRectangle({
          x: left, y: tableTop, width: 455, height: 30,
          color: rgb(0.05, 0.25, 0.5)
        });

        page.drawText("Subject", { x: colSubject, y: tableTop + 10, font: bold, size: 12, color: rgb(1,1,1) });
        page.drawText("Score",   { x: colScore,    y: tableTop + 10, font: bold, size: 12, color: rgb(1,1,1) });
        page.drawText("Comments",{ x: colComment,  y: tableTop + 10, font: bold, size: 12, color: rgb(1,1,1) });

        // -------- Table Rows (fixed no-strikethrough) --------
        let ty = tableTop - 20;
        const rows = Object.entries(data.scores).filter(([_,v]) => v !== null);

        rows.forEach(([subject, score], idx) => {
          page.drawText(subject, { x: colSubject, y: ty, size: 11, font });
          page.drawText(String(score), { x: colScore, y: ty, size: 11, font });

          // draw separator except last row
          if (idx < rows.length - 1) {
            page.drawLine({
              start: { x: left, y: ty - 5 },
              end: { x: left + 455, y: ty - 5 },
              thickness: 0.5,
              color: rgb(0.85, 0.85, 0.85)
            });
          }

          ty -= 30;
        });

        // -------- Longer comments --------
        ty -= 30;
        page.drawText("Longer comments", { x: 70, y: ty, size: 13, font: bold });
        ty -= 25;

        const lines = reportText.match(/.{1,90}(\s|$)/g) || [reportText];
        lines.forEach(line => {
          page.drawText(line.trim(), { x: 70, y: ty, size: 11, font });
          ty -= 18;
        });

        // Save PDF
        const filename = `${data.student_name.replace(/[^a-z0-9]/gi,"_")}_report.pdf`;
        const tmpPath = `/tmp/${filename}`;
        fs.writeFileSync(tmpPath, await pdf.save());

        // Send PDF to Telegram
        const form = new FormData();
        form.append("chat_id", chatId);
        form.append("document", fs.createReadStream(tmpPath), filename);

        await axios.post(`${TELEGRAM_API}/sendDocument`, form, {
          headers: form.getHeaders()
        });

        fs.unlinkSync(tmpPath);
      }

      await sendMessage(chatId, "✅ All PDF reports sent.");
      return res.status(200).send("ok");
    }

    return res.status(200).send("ok");

  } catch (err) {
    console.error(err);
    try {
      await sendMessage(req.body.message.chat.id, `❌ Error: ${err.message}`);
    } catch {}
    return res.status(200).send("ok");
  }
};
