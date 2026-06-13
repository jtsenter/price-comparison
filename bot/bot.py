import logging
import os
import tempfile

from dotenv import load_dotenv
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes

from lookup import parse_queries, build_reply

load_dotenv()

logging.basicConfig(
    format='%(asctime)s %(levelname)s %(message)s',
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

BOT_TOKEN = os.environ['TELEGRAM_BOT_TOKEN']
OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY', '')


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "👋 *PriceWatch Bot*\n\n"
        "Send me a list of grocery items and I'll tell you where to buy each one cheaper.\n\n"
        "Examples:\n"
        "  `milk, eggs, broccoli`\n"
        "  `bananas and yoghurt`\n"
        "  or just send a voice message 🎤",
        parse_mode='Markdown',
    )


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip()
    queries = parse_queries(text)
    if not queries:
        await update.message.reply_text("Send me a list of items, e.g. `milk, eggs, broccoli`", parse_mode='Markdown')
        return
    reply = build_reply(queries)
    await update.message.reply_text(reply, parse_mode='Markdown')


async def handle_voice(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not OPENAI_API_KEY:
        await update.message.reply_text(
            "Voice messages need an OpenAI API key.\n"
            "Add `OPENAI_API_KEY=...` to your `.env` file, or just type your items instead."
        )
        return

    import openai
    client = openai.OpenAI(api_key=OPENAI_API_KEY)

    await update.message.reply_text("🎤 Transcribing…")

    voice = update.message.voice or update.message.audio
    tg_file = await context.bot.get_file(voice.file_id)

    with tempfile.NamedTemporaryFile(suffix='.ogg', delete=False) as tmp:
        await tg_file.download_to_drive(tmp.name)
        tmp_path = tmp.name

    try:
        with open(tmp_path, 'rb') as f:
            transcript = client.audio.transcriptions.create(model='whisper-1', file=f)
        text = transcript.text
    finally:
        os.unlink(tmp_path)

    logger.info("Transcribed: %s", text)
    queries = parse_queries(text)

    if not queries:
        await update.message.reply_text(f'🎤 _{text}_\n\nCouldn\'t parse any items from that.', parse_mode='Markdown')
        return

    reply = f'🎤 _{text}_\n\n' + build_reply(queries)
    await update.message.reply_text(reply, parse_mode='Markdown')


async def main():
    app = Application.builder().token(BOT_TOKEN).connect_timeout(30).read_timeout(30).build()
    app.add_handler(CommandHandler('start', cmd_start))
    app.add_handler(CommandHandler('help', cmd_start))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
    app.add_handler(MessageHandler(filters.VOICE | filters.AUDIO, handle_voice))
    logger.info("Bot polling…")
    async with app:
        await app.start()
        await app.updater.start_polling(drop_pending_updates=True)
        await asyncio.Event().wait()


if __name__ == '__main__':
    import asyncio
    asyncio.run(main())
