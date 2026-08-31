export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processBseRss(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (url.pathname === '/api/announcements') {
      const data = await env.BSE_STORE.get('latest_announcements', { type: 'json' });
      return new Response(JSON.stringify(data || []), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*' 
        }
      });
    }

    return new Response('BSE Worker Active', { status: 200 });
  }
};

async function processBseRss(env) {
  const rssUrl = "https://beta.bseindia.com/data/xml/announcements.xml";
  const response = await fetch(rssUrl);
  const xmlText = await response.text();

  const items = parseBseXmlSimple(xmlText);
  const whitelistedScrips = await env.BSE_STORE.get('watchlist', { type: 'json' }) || [];
  
  let newAnnouncements = [];

  for (const item of items) {
    const kvKey = `ann:${item.scripCode}:${item.timestamp}`;
    const exists = await env.BSE_STORE.get(kvKey);

    if (!exists) {
      await env.BSE_STORE.put(kvKey, '1', { expirationTtl: 172800 });
      newAnnouncements.push(item);

      if (whitelistedScrips.includes(item.scripCode)) {
        await triggerAlerts(item, env);
      }
    }
  }

  if (newAnnouncements.length > 0) {
    const cached = await env.BSE_STORE.get('latest_announcements', { type: 'json' }) || [];
    const updated = [...newAnnouncements, ...cached].slice(0, 500);
    await env.BSE_STORE.put('latest_announcements', JSON.stringify(updated), { expirationTtl: 172800 });
  }
}

function parseBseXmlSimple(xml) {
  const items = [];
  const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

  for (const match of itemMatches) {
    const title = (match.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const link = (match.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
    const category = (match.match(/<category>([\s\S]*?)<\/category>/) || [])[1] || 'Other';
    const pubDate = (match.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';

    const scripMatch = title.match(/^(.*?)\s*\((\d{6})\)/);
    const companyName = scripMatch ? scripMatch[1].trim() : title;
    const scripCode = scripMatch ? scripMatch[2] : 'N/A';

    items.push({
      scripCode,
      companyName,
      title,
      pdfLink: link.trim(),
      category: category.trim() || 'Other',
      timestamp: pubDate
    });
  }
  return items;
}

async function triggerAlerts(item, env) {
  const msg = `🚨 <b>${item.companyName} (${item.scripCode})</b>\n\n` +
              `<b>Category:</b> ${item.category}\n` +
              `<b>Announcement:</b> ${item.title}\n\n` +
              `📄 <a href="${item.pdfLink}">View PDF Attachment</a>`;

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: 'HTML'
      })
    });
  }

  if (env.NTFY_TOPIC) {
    await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
      method: 'POST',
      headers: {
        'Title': `${item.companyName} (${item.scripCode})`,
        'Click': item.pdfLink,
        'Priority': 'high'
      },
      body: `${item.category}: ${item.title}`
    });
  }
}