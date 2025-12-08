const OpenAI = require('openai');
const axios = require('axios');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const LOGO_BASE64 = process.env.LOGO_BASE64 || "";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function sanitizeText(text) {
  return text
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/[—–]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x00-\x7F]/g, "");
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

function wrapText(text, maxWidth, font, fontSize) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const width = font.widthOfTextAtSize(testLine, fontSize);
    
    if (width <= maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

module.exports = async (req, res) => {
  if (req.method === "GET") return res.status(200).json({ status: "Bot is running!" });

  try {
    const update = req.body;

    if (update.message?.text === "/start" || update.message?.text === "/help") {
      await sendMessage(update.message.chat.id, `📚 Dorset House Report Bot

Send a voice note with student info. Structure it like:

"Harry Ramsden. English 7, Maths 5, PE 9. Really improved confidence this term, great attitude in class, needs to work on punctuation.

NEXT STUDENT

Lisa Simpson. English 9, Maths 9, PE 2. Excellent written work but hates rugby, tries hard though."

You'll receive professional letterheaded PDFs instantly.`);
      return res.status(200).send("ok");
    }

    if (!update.message?.voice) {
      await sendMessage(update.message.chat.id, "Please send a voice note with student reports.");
      return res.status(200).send("ok");
    }

    const chatId = update.message.chat.id;
    const fileId = update.message.voice.file_id;

    await sendMessage(chatId, "🎙️ Transcribing and creating your reports...");

    const audioBuffer = await downloadVoiceFile(fileId);
    const audioFile = new File([audioBuffer], "voice.ogg", { type: "audio/ogg" });

    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      language: "en"
    });

    const segments = transcription.text
      .split(/next student/i)
      .map(s => s.trim())
      .filter(s => s.length > 10);

    if (segments.length === 0) {
      await sendMessage(chatId, "❌ Couldn't find any students. Try saying 'NEXT STUDENT' between each one.");
      return res.status(200).send("ok");
    }

    await sendMessage(chatId, `✅ Found ${segments.length} student(s). Generating PDFs...`);

    for (let i = 0; i < segments.length; i++) {
      const studentText = segments[i];

      const parseResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [{ 
          role: "user", 
          content: `Parse this teacher's voice note into JSON. Extract student name, numerical scores (1-10 scale), and all descriptive comments.

Voice note: "${studentText}"

Return ONLY valid JSON (no markdown):
{
  "student_name": "Full Name",
  "scores": {
    "English": 7,
    "Maths": 5,
    "PE": 9,
    "Science": null,
    "History": null,
    "Geography": null
  },
  "teacher_notes": "All the descriptive comments about attitude, progress, strengths, weaknesses, behaviour, etc."
}

If a subject isn't mentioned, set it to null. Include ALL subjects that were mentioned.`
        }]
      });

      let data;
      try {
        const json = parseResp.choices[0].message.content.replace(/```json|```/g, "").trim();
        data = JSON.parse(json);
      } catch (e) {
        console.error("Parse error for student", i+1, e);
        await sendMessage(chatId, `⚠️ Couldn't parse student ${i+1}. Skipping...`);
        continue;
      }

      const subjectCommentsResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.7,
        messages: [{ 
          role: "user", 
          content: `You're a 25-year-old male British teacher. Cool but professional. Write SHORT 3-5 word comments for each subject.

Student: ${data.student_name}
Teacher's notes: "${data.teacher_notes}"
Scores: ${JSON.stringify(data.scores)}

Return ONLY valid JSON (no markdown):
{
  "English": "Strong creative writing",
  "Maths": "Needs more practice",
  "PE": "Excellent team player"
}

Only include subjects with scores. Keep it brief, positive, honest. Don't be stuffy.`
        }]
      });

      let subjectComments = {};
      try {
        const json = subjectCommentsResp.choices[0].message.content.replace(/```json|```/g, "").trim();
        subjectComments = JSON.parse(json);
      } catch (e) {
        console.error("Subject comments parse error", e);
        Object.keys(data.scores).forEach(subject => {
          if (data.scores[subject] !== null) {
            subjectComments[subject] = data.scores[subject] >= 7 ? "Good progress" : "Working hard";
          }
        });
      }

      const reportResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.8,
        messages: [{ 
          role: "user", 
          content: `You're a 25-year-old male British teacher at Dorset House. You're cool, relatable, down with the kids - but still professional. You're not stuffy or overly formal. Write like you'd actually talk to parents in person: warm, genuine, specific.

Write a 120-150 word report for ${data.student_name}.

Scores:
${Object.entries(data.scores).filter(([_,v])=>v!==null).map(([s,v])=>`- ${s}: ${v}/10`).join("\n")}

Your notes: "${data.teacher_notes || "General progress noted"}"

Key rules:
- Start with something positive and specific (not generic)
- Be honest about challenges but frame constructively
- Use natural language ("he's really stepped up", "she's smashing it", "we've had some wobbles but...")
- Mention 1-2 concrete examples if possible
- End with encouragement and maybe one thing to work on
- Sound like a human, not a BBC newsreader
- No bullet points, just flowing paragraphs
- IMPORTANT: Use only simple ASCII characters - no smart quotes, em-dashes, or special symbols

Write the report now:`
        }]
      });
      const reportText = sanitizeText(reportResp.choices[0].message.content.trim());

      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([595, 842]);
      const { width, height } = page.getSize();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      if (LOGO_BASE64 && LOGO_BASE64.length > 100) {
        try {
          const base64Data = LOGO_BASE64.includes('base64,') 
            ? LOGO_BASE64.split('base64,')[1] 
            : LOGO_BASE64;
          const logoBytes = Buffer.from(base64Data, 'base64');
          
          const logoImage = LOGO_BASE64.includes('jpeg') || LOGO_BASE64.includes('jpg')
            ? await pdfDoc.embedJpg(logoBytes)
            : await pdfDoc.embedPng(logoBytes);
            
          const logoDims = logoImage.scale(0.35);
          page.drawImage(logoImage, {
            x: width - 160,
            y: height - 130,
            width: logoDims.width,
            height: logoDims.height,
          });
        } catch (logoErr) {
          console.error("Logo embed failed:", logoErr);
        }
      }

      let y = height - 100;
      page.drawText(sanitizeText("Church Ln,"), { x: width - 190, y: y -= 18, size: 10, font });
      page.drawText(sanitizeText("Bury,"), { x: width - 190, y: y -= 16, size: 10, font });
      page.drawText(sanitizeText("Pulborough,"), { x: width - 190, y: y -= 16, size: 10, font });
      page.drawText(sanitizeText("RH20 1PB"), { x: width - 190, y: y -= 20, size: 10, font, color: rgb(0, 0.3, 0.6) });

      page.drawText(sanitizeText("Dear Parent,"), { x: 70, y: height - 180, size: 12, font: bold });
      page.drawText(sanitizeText(`Please find below ${data.student_name}'s latest report.`), { 
        x: 70, y: height - 210, size: 11, font 
      });
      page.drawText(sanitizeText("We're really pleased with their progress this term."), { 
        x: 70, y: height - 230, size: 11, font 
      });

      const left = 70;
      const col1 = 70;
      const col2 = 230;
      const col3 = 310;
      const tableTop = height - 300;

      page.drawRectangle({ 
        x: left, y: tableTop + 5, width: 455, height: 28, 
        color: rgb(0.05, 0.25, 0.5) 
      });
      page.drawText(sanitizeText("Subject"), { 
        x: col1 + 10, y: tableTop + 13, size: 11, font: bold, color: rgb(1,1,1) 
      });
      page.drawText(sanitizeText("Score"), { 
        x: col2 + 10, y: tableTop + 13, size: 11, font: bold, color: rgb(1,1,1) 
      });
      page.drawText(sanitizeText("Comments"), { 
        x: col3 + 10, y: tableTop + 13, size: 11, font: bold, color: rgb(1,1,1) 
      });

      page.drawLine({ 
        start: {x: left, y: tableTop + 33}, 
        end: {x: left + 455, y: tableTop + 33}, 
        thickness: 1.5 
      });

      [col2, col3].forEach(col => {
        page.drawLine({ 
          start: {x: col, y: tableTop + 33}, 
          end: {x: col, y: tableTop - 200}, 
          thickness: 0.5, 
          color: rgb(0.7,0.7,0.7) 
        });
      });

      y = tableTop - 8;
      const subjects = Object.entries(data.scores).filter(([_, score]) => score !== null);
      
      subjects.forEach(([subject, score], idx) => {
        page.drawText(sanitizeText(subject), { 
          x: col1 + 10, y: y, size: 10, font 
        });
        
        page.drawText(sanitizeText(score.toString()), { 
          x: col2 + 15, y: y, size: 10, font 
        });
        
        const comment = subjectComments[subject] || "Progressing well";
        page.drawText(sanitizeText(comment), { 
          x: col3 + 10, y: y, size: 9, font,
          maxWidth: 200
        });

        if (idx < subjects.length - 1) {
          page.drawLine({ 
            start: {x: left, y: y - 10}, 
            end: {x: left + 455, y: y - 10}, 
            thickness: 0.5, 
            color: rgb(0.85,0.85,0.85) 
          });
        }
        
        y -= 35;
      });

      page.drawLine({ 
        start: {x: left, y: tableTop - 200}, 
        end: {x: left + 455, y: tableTop - 200}, 
        thickness: 1.5 
      });

      y = tableTop - 240;
      page.drawText(sanitizeText("Detailed Comments"), { 
        x: 70, y: y, size: 12, font: bold 
      });
      
      y -= 25;
      const reportLines = wrapText(reportText, 450, font, 10.5);
      reportLines.forEach(line => {
        page.drawText(sanitizeText(line), { 
          x: 70, y: y, size: 10.5, font, lineHeight: 16 
        });
        y -= 18;
      });

      y -= 40;
      if (y > 80) {
        page.drawText(sanitizeText("Please don't hesitate to get in touch if you'd like to discuss anything."), {
          x: 70, y: y, size: 9, font, color: rgb(0.4, 0.4, 0.4)
        });
      }

      const pdfBytes = await pdfDoc.save();
      const safeName = data.student_name.replace(/[^a-zA-Z0-9]/g, "_");
      const filename = `${safeName}_Report.pdf`;
      const tmpPath = `/tmp/${filename}`;
      fs.writeFileSync(tmpPath, pdfBytes);

      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('document', fs.createReadStream(tmpPath), { filename });
      form.append('caption', `📄 ${data.student_name}'s Report`);

      await axios.post(`${TELEGRAM_API}/sendDocument`, form, { 
        headers: form.getHeaders() 
      });
      fs.unlinkSync(tmpPath);

      console.log(`✅ Report generated for ${data.student_name}`);
    }

    await sendMessage(chatId, "✨ All reports sent! Looking professional 👌");

  } catch (err) {
    console.error("Fatal error:", err);
    if (req.body.message?.chat?.id) {
      await sendMessage(req.body.message.chat.id, `❌ Error: ${err.message}`);
    }
  }

  res.status(200).send("ok");
};
