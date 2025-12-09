const OpenAI = require('openai');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const Mustache = require('mustache');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

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
        messages: [{ role: "user", content: `Write a warm, professional 80–100 word British school report. From young male teacher, not stuffy for ${data.student_name}.
Scores:\n${Object.entries(data.scores).filter(([_,v])=>v!==null).map(([s,v])=>`- ${s}: ${v}/10`).join("\n") || "No scores"}
Notes: "${data.teacher_notes || ""}"`}]
      });
      const reportText = reportResp.choices[0].message.content.trim();

      // Generate short subject comments
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
{"English": "Strong creative writing", "Maths": "Needs more practice"}`
        }]
      });

      let subjectComments = {};
      try {
        const json = subjectCommentsResp.choices[0].message.content.replace(/```json|```/g, "").trim();
        subjectComments = JSON.parse(json);
      } catch (e) {
        Object.keys(data.scores).forEach(subject => {
          if (data.scores[subject]) {
            subjectComments[subject] = data.scores[subject] >= 7 ? "Good progress" : "Working hard";
          }
        });
      }

      // Prepare data for HTML template
      const subjects = Object.entries(data.scores)
        .filter(([_, score]) => score !== null)
        .map(([name, score]) => ({
          name: name,
          score: score.toString(),
          comments: subjectComments[name] || "Progressing well"
        }));

      // Read HTML template
      const htmlTemplate = fs.readFileSync(__dirname + '/template.html', 'utf8');

      // Read logo as base64
      const logoBase64 = fs.readFileSync(__dirname + '/logo_base64.txt', 'utf8');
      
      // Fill template with Mustache
      const filledHtml = Mustache.render(htmlTemplate, {
        STUDENT_NAME: data.student_name,
        SUBJECTS: subjects,
        REPORT_TEXT: reportText,
        LOGO_BASE64: `data:image/jpeg;base64,${logoBase64}`
      });

      // Convert HTML to PDF using Puppeteer
      const browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless
      });

      const page = await browser.newPage();
      await page.setContent(filledHtml, { waitUntil: 'networkidle0' });
      const pdfBytes = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' }
      });
      await browser.close();

      // SEND PDF
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
