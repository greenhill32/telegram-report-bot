# Telegram Report Bot - Vercel Deployment Guide

## 🚀 Deploy to Vercel (10 minutes total)

### Step 1: Create Your Telegram Bot (2 mins)

1. Open Telegram on your iPhone
2. Search for `@BotFather`
3. Send `/newbot`
4. Name it: `ReportBot` (or whatever you like)
5. Username: `harry_report_bot` (must end in `bot`)
6. **Save the token** BotFather gives you (looks like: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

---

### Step 2: Deploy to Vercel (5 mins)

#### Option A: Deploy with Vercel Dashboard (Easiest)

1. Go to https://vercel.com
2. Sign up with GitHub (free, no credit card needed)
3. Click "Add New" → "Project"
4. Import this folder:
   - Either connect your GitHub repo
   - Or drag & drop this entire folder
5. Vercel will auto-detect the project
6. Click "Deploy"
7. Wait ~1 minute for deployment

#### Option B: Deploy with Vercel CLI

```bash
# Install Vercel CLI
npm i -g vercel

# Navigate to this folder
cd telegram-bot-vercel

# Deploy
vercel

# Follow prompts, then deploy to production
vercel --prod
```

---

### Step 3: Set Environment Variables (2 mins)

1. In Vercel dashboard, go to your project
2. Click "Settings" → "Environment Variables"
3. Add these two variables:

   **Variable 1:**
   - Name: `TELEGRAM_TOKEN`
   - Value: Your bot token from BotFather

   **Variable 2:**
   - Name: `OPENAI_API_KEY`
   - Value: Your OpenAI API key

4. Click "Save"
5. **Important:** Go to "Deployments" and click "Redeploy" (so new env vars take effect)

---

### Step 4: Set Up Webhook (1 min)

After deployment, Vercel gives you a URL like: `https://your-project.vercel.app`

Now tell Telegram where to send messages:

**Option A: Use your browser**

Visit this URL (replace the placeholders):
```
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://<YOUR_VERCEL_URL>/api/webhook
```

Example:
```
https://api.telegram.org/bot123456789:ABCdefGHIjklMNOpqrsTUVwxyz/setWebhook?url=https://my-report-bot.vercel.app/api/webhook
```

You should see: `{"ok":true,"result":true,"description":"Webhook was set"}`

**Option B: Use Terminal**

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -d "url=https://<YOUR_VERCEL_URL>/api/webhook"
```

---

### Step 5: Test It! (30 seconds)

1. Open Telegram on iPhone
2. Search for your bot (e.g., `@harry_report_bot`)
3. Send `/start`
4. Send a voice note:
   > "Harry Thompson. English 5, Maths 3, PE 7. Harry struggles with focus but excels in sport."
5. Get report back in 10 seconds!

---

## ✅ Verification Checklist

- [ ] Bot created in BotFather
- [ ] Deployed to Vercel (green checkmark)
- [ ] Environment variables set
- [ ] Project redeployed after adding env vars
- [ ] Webhook set (got success message)
- [ ] `/start` command works
- [ ] Voice note generates report

---

## 📱 How to Use

**Voice Note Format:**
```
[Student Name]. [Subject] [score], [Subject] [score], [etc]. [Teacher notes].
```

**Examples:**

✅ Good:
- "Harry Thompson. English 5, Maths 3, Science 6, PE 7. Really improved this term."
- "Sarah Jones. English 8, Maths 9, PE 6. Outstanding work ethic."
- "Tom Brown. English 4, Maths 5. Needs to focus more in class."

---

## 💰 Costs

- **Vercel hosting**: FREE forever (generous free tier)
- **OpenAI API**: ~£0.01-0.02 per report (£3-5/month for 300 reports)
- **Telegram**: Free

**Total: ~£5/month maximum**

---

## 🔧 Troubleshooting

### Bot doesn't respond

**Check webhook is set:**
```
https://api.telegram.org/bot<YOUR_TOKEN>/getWebhookInfo
```

Should show your Vercel URL. If not, redo Step 4.

**Check Vercel logs:**
1. Go to Vercel dashboard
2. Click your project
3. Go to "Logs" tab
4. Send a test message
5. See if errors appear

**Check environment variables:**
1. Settings → Environment Variables
2. Make sure both are set
3. Redeploy after adding them

### Voice not transcribing

- Telegram voice notes work best (hold mic button in chat)
- Don't send video messages or external audio files
- Make sure OpenAI API key has credits

### Report format is wrong

- Be explicit: "English 5, Maths 3" not "English five"
- Always say student name first
- Use numbers, not words for scores

---

## 🎯 How It Works (Technical)

1. You send voice note to Telegram
2. Telegram sends it to your Vercel webhook
3. Vercel function downloads the audio
4. Whisper transcribes it
5. GPT-4o-mini parses name/scores/notes
6. GPT-4o-mini generates polished report
7. Response sent back to Telegram
8. Vercel goes back to sleep (costs £0)

**Total time: 10-15 seconds**

---

## 🆚 Vercel vs Railway

**Vercel (what you're using):**
- ✅ FREE forever
- ✅ Faster cold starts
- ✅ Better free tier
- ✅ Automatic scaling
- ✅ Simpler deployment

**Railway:**
- Requires polling (less efficient)
- Free tier runs out faster
- More complex setup

**Verdict:** Vercel is perfect for this use case.

---

## 🔐 Security

- Environment variables are encrypted by Vercel
- Bot token never exposed in code
- OpenAI key stays server-side
- No data stored (unless you add database later)

---

## 📊 Future Features (Easy to Add)

Want to add these later? Just ask:
- Export reports to PDF
- Store reports in Supabase
- Batch export all reports
- Compare scores across terms
- Custom report templates

---

## 🆘 Support

If something breaks:

1. Check Vercel logs first
2. Verify webhook is set: `/getWebhookInfo`
3. Test with `/start` command
4. Check environment variables exist
5. Redeploy project

The bot should "just work" once deployed correctly.

---

## 🎓 Commands

- `/start` - Welcome message
- `/help` - Format instructions
- Voice note - Generate report

That's it! Simple and effective.
