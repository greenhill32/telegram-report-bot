const OpenAI = require('openai');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } = require('docx');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

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
  if (req.method === "GET") return res.status(200).json({ status: "Bot is running!" });

  try {
    const update = req.body;

    if (update.message?.text === "/start" || update.message?.text === "/help") {
      await sendMessage(update.message.chat.id, `📚 Dorset House Report Bot

Send a voice note:

"Harry Ramsden. English 7, Maths 5, PE 9. Really improved confidence, great attitude, needs punctuation work.

NEXT STUDENT

Lisa Simpson. English 9, Maths 9, PE 2. Excellent written work, hates rugby but tries hard."

You'll get editable Word documents instantly.`);
      return res.status(200).send("ok");
    }

    if (!update.message?.voice) {
      await sendMessage(update.message.chat.id, "Please send a voice note with student reports.");
      return res.status(200).send("ok");
    }

    const chatId = update.message.chat.id;
    const fileId = update.message.voice.file_id;

    await sendMessage(chatId, "🎙️ Transcribing and creating reports...");

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
      await sendMessage(chatId, "❌ Couldn't find students. Say 'NEXT STUDENT' between each.");
      return res.status(200).send("ok");
    }

    await sendMessage(chatId, `✅ Found ${segments.length} student(s). Generating Word docs...`);

    for (let i = 0; i < segments.length; i++) {
      const studentText = segments[i];

      const parseResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [{ 
          role: "user", 
          content: `Parse this teacher's voice note into JSON.

Voice note: "${studentText}"

Return ONLY valid JSON:
{
  "student_name": "Full Name",
  "scores": {
    "English": 7,
    "Maths": 5,
    "PE": 9,
    "Science": null
  },
  "teacher_notes": "All descriptive comments"
}`
        }]
      });

      let data;
      try {
        const json = parseResp.choices[0].message.content.replace(/```json|```/g, "").trim();
        data = JSON.parse(json);
      } catch (e) {
        await sendMessage(chatId, `⚠️ Couldn't parse student ${i+1}. Skipping...`);
        continue;
      }

      const subjectCommentsResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.7,
        messages: [{ 
          role: "user", 
          content: `You're a 25-year-old British teacher. Write SHORT 3-5 word comments for each subject.

Student: ${data.student_name}
Notes: "${data.teacher_notes}"
Scores: ${JSON.stringify(data.scores)}

Return ONLY JSON:
{
  "English": "Strong creative writing",
  "Maths": "Needs more practice"
}`
        }]
      });

      let subjectComments = {};
      try {
        const json = subjectCommentsResp.choices[0].message.content.replace(/```json|```/g, "").trim();
        subjectComments = JSON.parse(json);
      } catch (e) {
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
          content: `You're a 25-year-old British teacher. Cool but professional. Write 120-150 words for ${data.student_name}.

Scores: ${Object.entries(data.scores).filter(([_,v])=>v!==null).map(([s,v])=>`${s}: ${v}/10`).join(", ")}
Notes: "${data.teacher_notes}"

Natural language ("he's stepped up", "smashing it"). Be honest, warm, specific. No bullet points.`
        }]
      });
      const reportText = reportResp.choices[0].message.content.trim();

      // BUILD DOCX
      const subjects = Object.entries(data.scores).filter(([_, score]) => score !== null);
      
      const tableRows = [
        new TableRow({
          children: [
            new TableCell({
              children: [new Paragraph({ text: "Subject", bold: true })],
              shading: { fill: "1E3A5F" },
              width: { size: 35, type: WidthType.PERCENTAGE }
            }),
            new TableCell({
              children: [new Paragraph({ text: "Score", bold: true })],
              shading: { fill: "1E3A5F" },
              width: { size: 15, type: WidthType.PERCENTAGE }
            }),
            new TableCell({
              children: [new Paragraph({ text: "Comments", bold: true })],
              shading: { fill: "1E3A5F" },
              width: { size: 50, type: WidthType.PERCENTAGE }
            })
          ]
        }),
        ...subjects.map(([subject, score]) => 
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph(subject)] }),
              new TableCell({ children: [new Paragraph(score.toString())] }),
              new TableCell({ children: [new Paragraph(subjectComments[subject] || "Progressing well")] })
            ]
          })
        )
      ];

      const doc = new Document({
        sections: [{
          children: [
            // Header address (right-aligned, can delete if printing on letterhead)
            new Paragraph({
              children: [new TextRun({ text: "Church Ln, Bury, Pulborough, RH20 1PB", size: 20, color: "1E3A5F" })],
              alignment: AlignmentType.RIGHT,
              spacing: { after: 400 }
            }),
            
            // Dear Parent
            new Paragraph({
              children: [new TextRun({ text: "Dear Parent,", bold: true, size: 24 })],
              spacing: { after: 200 }
            }),
            new Paragraph({
              text: `Please find below ${data.student_name}'s latest report.`,
              spacing: { after: 100 }
            }),
            new Paragraph({
              text: "We're really pleased with their progress this term.",
              spacing: { after: 400 }
            }),

            // Table
            new Table({
              rows: tableRows,
              width: { size: 100, type: WidthType.PERCENTAGE },
              borders: {
                top: { style: BorderStyle.SINGLE, size: 1 },
                bottom: { style: BorderStyle.SINGLE, size: 1 },
                left: { style: BorderStyle.SINGLE, size: 1 },
                right: { style: BorderStyle.SINGLE, size: 1 },
                insideHorizontal: { style: BorderStyle.SINGLE, size: 1 },
                insideVertical: { style: BorderStyle.SINGLE, size: 1 }
              }
            }),

            new Paragraph({ text: "", spacing: { after: 400 } }),

            // Detailed comments
            new Paragraph({
              children: [new TextRun({ text: "Detailed Comments", bold: true, size: 26 })],
              spacing: { after: 200 }
            }),
            new Paragraph({
              text: reportText,
              spacing: { after: 400 }
            }),

            // Footer
            new Paragraph({
              text: "Please don't hesitate to get in touch if you'd like to discuss anything.",
              italics: true,
              color: "666666"
            })
          ]
        }]
      });

      const buffer = await Packer.toBuffer(doc);
      const safeName = data.student_name.replace(/[^a-zA-Z0-9]/g, "_");
      const filename = `${safeName}_Report.docx`;
      const tmpPath = `/tmp/${filename}`;
      fs.writeFileSync(tmpPath, buffer);

      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('document', fs.createReadStream(tmpPath), { filename });
      form.append('caption', `📄 ${data.student_name}'s Report (editable)`);

      await axios.post(`${TELEGRAM_API}/sendDocument`, form, { 
        headers: form.getHeaders() 
      });
      fs.unlinkSync(tmpPath);

      console.log(`✅ Report generated for ${data.student_name}`);
    }

    await sendMessage(chatId, "✨ All reports sent as Word docs!");

  } catch (err) {
    console.error("Error:", err);
    if (req.body.message?.chat?.id) {
      await sendMessage(req.body.message.chat.id, `❌ Error: ${err.message}`);
    }
  }

  res.status(200).send("ok");
};
