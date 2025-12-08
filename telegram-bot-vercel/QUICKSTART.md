# Quick Start - 5 Minute Setup

## For People Who Just Want It Working

### 1. Create Bot (2 mins)
- Open Telegram → search `@BotFather`
- Send `/newbot` → follow prompts
- Copy the token you get

### 2. Deploy (2 mins)
- Go to https://vercel.com/new
- Sign up with GitHub (free)
- Upload this entire folder
- Click "Deploy"

### 3. Set Secrets (1 min)
In Vercel dashboard:
- Settings → Environment Variables
- Add `TELEGRAM_TOKEN` = your bot token
- Add `OPENAI_API_KEY` = your OpenAI key
- Click "Redeploy"

### 4. Connect Webhook (30 secs)
Visit in browser (replace YOUR_TOKEN and YOUR_URL):
```
https://api.telegram.org/botYOUR_TOKEN/setWebhook?url=https://YOUR_URL.vercel.app/api/webhook
```

### 5. Test (30 secs)
- Open Telegram
- Find your bot
- Send voice note
- Get report!

---

## Done!

That's literally it. The bot is now live on your iPhone forever (or until you delete it).

**Total cost: ~£5/month for OpenAI**
**Hosting: FREE**

---

## Example Voice Notes

Just speak naturally:

- "Harry Thompson. English 5, Maths 3, PE 7. Great at sport, struggles with maths."
- "Sarah Jones. English 8, Maths 9. Brilliant student, very focused."
- "Tom Brown. English 4, Maths 5, Science 6. Improving slowly."

You'll get back a professionally written 120-150 word report in British school style.

---

## Troubleshooting

**Bot doesn't respond:**
- Did you set webhook? (Step 4)
- Did you redeploy after adding env vars?
- Check Vercel logs for errors

**Can't find bot:**
- Search for the exact username you gave BotFather
- Username ends in "bot"

**"Error processing":**
- Check OpenAI API key has credits
- Make sure you're sending voice notes (not text)

---

**That's it. No other steps. No hidden complexity.**
