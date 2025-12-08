const OpenAI = require('openai');
const axios = require('axios');
// Switch from pdf-lib to docx to generate high-quality DOCX reports instead of PDFs
const {
  Document,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  Packer,
  WidthType,
  AlignmentType,
  ImageRun,
} = require('docx');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

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
      await sendMessage(update.message.chat.id, `Dorset House Report Bot

Send a voice note like:
"Harry Ramsden. English 5, Maths 7, PE 10. Brilliant term.
NEXT STUDENT
Lisa Simpson. English 9, Maths 9, PE 2. Hates rugby."

You’ll receive beautiful letterheaded DOCX reports instantly.`);
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

    // Inform the user that DOCX reports are being created instead of PDFs
    await sendMessage(chatId, `Found ${segments.length} student(s). Generating letterheaded DOCX reports...`);

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
        messages: [{ role: "user", content: `Write a warm, professional 80–100 word British school report. From young male teacher, not stuffy for ${data.student_name}.
Scores:\n${Object.entries(data.scores).filter(([_,v])=>v!==null).map(([s,v])=>`- ${s}: ${v}/10`).join("\n") || "No scores"}
Notes: "${data.teacher_notes || ""}"`}]
      });
      const reportText = reportResp.choices[0].message.content.trim();

      // PROFESSIONAL DORSET HOUSE DOCX
      // Create a DOCX document for each student with logo and address in the top-right
      const doc = new Document();
      // Determine logo path and read bytes
      let logoBytes;
      let logoPath;
      if (fs.existsSync("logo.jpg") || fs.existsSync("logo.png")) {
        logoPath = fs.existsSync("logo.jpg") ? "logo.jpg" : "logo.png";
        logoBytes = fs.readFileSync(logoPath);
      }
      // Build header table: blank left cell and right cell with logo and address
      const headerRow = new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph("")],
            width: { size: 65, type: WidthType.PERCENTAGE },
            borders: { top: { style: 'none' }, bottom: { style: 'none' }, left: { style: 'none' }, right: { style: 'none' } },
          }),
          new TableCell({
            children: (
              logoBytes
                ? [
                    new Paragraph({
                      children: [
                        new ImageRun({
                          data: logoBytes,
                          transformation: { width: 90, height: 120 },
                        }),
                      ],
                      alignment: AlignmentType.RIGHT,
                    }),
                    new Paragraph({ text: "Church Ln", alignment: AlignmentType.RIGHT }),
                    new Paragraph({ text: "Bury", alignment: AlignmentType.RIGHT }),
                    new Paragraph({ text: "Pulborough", alignment: AlignmentType.RIGHT }),
                    new Paragraph({
                      children: [new TextRun({ text: "RH20 1PB", bold: true, color: "004C99" })],
                      alignment: AlignmentType.RIGHT,
                    }),
                  ]
                : [
                    new Paragraph({ text: "Church Ln", alignment: AlignmentType.RIGHT }),
                    new Paragraph({ text: "Bury", alignment: AlignmentType.RIGHT }),
                    new Paragraph({ text: "Pulborough", alignment: AlignmentType.RIGHT }),
                    new Paragraph({
                      children: [new TextRun({ text: "RH20 1PB", bold: true, color: "004C99" })],
                      alignment: AlignmentType.RIGHT,
                    }),
                  ]
            ),
            width: { size: 35, type: WidthType.PERCENTAGE },
            borders: { top: { style: 'none' }, bottom: { style: 'none' }, left: { style: 'none' }, right: { style: 'none' } },
          }),
        ],
      });
      const headerTable = new Table({
        rows: [headerRow],
        width: { size: 100, type: WidthType.PERCENTAGE },
      });

      // Greeting paragraphs
      const greetingParas = [
        new Paragraph({ text: "Dear Parent,", bold: true }),
        new Paragraph({ text: "Please find below the latest report for your child." }),
        new Paragraph({ text: "We are very proud of their progress this term." }),
      ];

      // Build table with scores and comments
      const scoreRows = [];
      // Header row with bold labels
      // Create a header row with dark blue background and white text for clarity
      scoreRows.push(
        new TableRow({
          children: [
            new TableCell({
              shading: { fill: "004C99" },
              children: [
                new Paragraph({
                  children: [new TextRun({ text: "Subject", bold: true, color: "FFFFFF" })],
                  alignment: AlignmentType.CENTER,
                }),
              ],
              width: { size: 30, type: WidthType.PERCENTAGE },
            }),
            new TableCell({
              shading: { fill: "004C99" },
              children: [
                new Paragraph({
                  children: [new TextRun({ text: "Score", bold: true, color: "FFFFFF" })],
                  alignment: AlignmentType.CENTER,
                }),
              ],
              width: { size: 15, type: WidthType.PERCENTAGE },
            }),
            new TableCell({
              shading: { fill: "004C99" },
              children: [
                new Paragraph({
                  children: [new TextRun({ text: "Comments", bold: true, color: "FFFFFF" })],
                  alignment: AlignmentType.CENTER,
                }),
              ],
              width: { size: 55, type: WidthType.PERCENTAGE },
            }),
          ],
        })
      );
      for (const [subject, level] of Object.entries(data.scores)) {
        if (level === null) continue;
        let comment = data.teacher_notes || "";
        // Comments per subject can be extended here if needed
        scoreRows.push(
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph(subject)] }),
              new TableCell({ children: [new Paragraph(level.toString())] }),
              new TableCell({ children: [new Paragraph(comment)] }),
            ],
          })
        );
      }
      const scoresTable = new Table({ rows: scoreRows, width: { size: 100, type: WidthType.PERCENTAGE } });

      // Longer comments section
      const longCommentHeading = new Paragraph({ text: "Longer comments", bold: true, color: "004C99" });
      const longCommentPara = new Paragraph(reportText);

      // Assemble document sections
      doc.addSection({
        properties: {},
        children: [
          headerTable,
          ...greetingParas,
          scoresTable,
          longCommentHeading,
          longCommentPara,
        ],
      });

      // Save DOCX to temporary file
      const safeName = data.student_name.replace(/[^a-zA-Z0-9]/g, "_");
      const filename = `${safeName}_report.docx`;
      const tmpPath = `/tmp/${filename}`;
      const buffer = await Packer.toBuffer(doc);
      fs.writeFileSync(tmpPath, buffer);
      // Prepare form data and send the DOCX
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('document', fs.createReadStream(tmpPath), { filename });
      form.append('caption', `Report for ${data.student_name}`);
      await axios.post(`${TELEGRAM_API}/sendDocument`, form, { headers: form.getHeaders() });
      fs.unlinkSync(tmpPath);
    }

    // Update final message to accurately reflect DOCX format
    await sendMessage(chatId, "All reports sent as beautiful DOCX files!");

  } catch (err) {
    console.error(err);
    if (req.body.message?.chat?.id) {
      await sendMessage(req.body.message.chat.id, `Error: ${err.message}`);
    }
  }

  res.status(200).send("ok");
};
