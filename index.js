export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processBseRss(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (!env.BSE_STORE) {
        return new Response(JSON.stringify({ error: "BSE_STORE KV binding is missing in Cloudflare settings." }), {
          status: 500,
          headers: corsHeaders,
        });
      }

      // Serve announcements on root / or /api/announcements
      if (url.pathname === '/api/announcements' || url.pathname === '/') {
        const rawData = await env.BSE_STORE.get('latest_announcements');
        const items = rawData ? JSON.parse(rawData) : [];
        return new Response(JSON.stringify(items), {
          status: 200,
          headers: corsHeaders,
        });
      }

      // Manual execution route
      if (url.pathname === '/api/trigger-cron') {
        const resultCount = await processBseRss(env);
        const rawData = await env.BSE_STORE.get('latest_announcements');
        const items = rawData ? JSON.parse(rawData) : [];
        return new Response(JSON.stringify({ success: true, newFetched: resultCount, totalInStore: items.length }), {
          status: 200,
          headers: corsHeaders,
        });
      }

      return new Response(JSON.stringify({ error: 'Not Found' }), { 
        status: 404,
        headers: corsHeaders 
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }
};

async function processBseRss(env) {
  if (!env.BSE_STORE) return 0;

  try {
    const rssUrl = "https://beta.bseindia.com/data/xml/announcements.xml";
    const response = await fetch(rssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });

    if (!response.ok) return 0;
    const xmlText = await response.text();

    const items = parseBseXmlSimple(xmlText);
    
    let whitelistedScrips = [];
    try {
      const watchlistRaw = await env.BSE_STORE.get('watchlist');
      whitelistedScrips = watchlistRaw ? JSON.parse(watchlistRaw) : [];
    } catch (e) {
      whitelistedScrips = [];
    }
    
    let newAnnouncements = [];

    for (const item of items) {
      const kvKey = `ann:${item.scripCode}:${item.timestamp}`;
      const exists = await env.BSE_STORE.get(kvKey);

      if (!exists) {
        await env.BSE_STORE.put(kvKey, '1', { expirationTtl: 172800 });
        newAnnouncements.push(item);

        if (Array.isArray(whitelistedScrips) && whitelistedScrips.includes(item.scripCode)) {
          await triggerAlerts(item, env);
        }
      }
    }

    if (newAnnouncements.length > 0) {
      const cachedRaw = await env.BSE_STORE.get('latest_announcements');
      const cached = cachedRaw ? JSON.parse(cachedRaw) : [];
      const updated = [...newAnnouncements, ...cached].slice(0, 500);
      await env.BSE_STORE.put('latest_announcements', JSON.stringify(updated), { expirationTtl: 172800 });
    }

    return newAnnouncements.length;
  } catch (err) {
    console.error("Error processing BSE RSS feed:", err);
    return 0;
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