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
        return new Response(JSON.stringify({ error: "BSE_STORE KV binding missing" }), {
          status: 500,
          headers: corsHeaders,
        });
      }

      if (url.pathname === '/api/announcements' || url.pathname === '/') {
        const rawData = await env.BSE_STORE.get('latest_announcements');
        const items = rawData ? JSON.parse(rawData) : [];
        return new Response(JSON.stringify(items), {
          status: 200,
          headers: corsHeaders,
        });
      }

      if (url.pathname === '/api/trigger-cron') {
        const count = await processBseRss(env);
        const rawData = await env.BSE_STORE.get('latest_announcements');
        const items = rawData ? JSON.parse(rawData) : [];
        return new Response(JSON.stringify({ success: true, newFetched: count, totalInStore: items.length }), {
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

  // Use BSE's native JSON endpoint with browser headers
  const apiUrl = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryData/w?categoryId=0&subCategoryId=0&strCat=-1&strPrevDate=&strScrip=";

  try {
    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.bseindia.com/',
        'Origin': 'https://www.bseindia.com'
      }
    });

    if (!response.ok) return 0;

    const data = await response.json();
    const rawItems = data?.Table || [];
    if (!Array.isArray(rawItems) || rawItems.length === 0) return 0;

    // Map API fields to frontend template properties
    const items = rawItems.map(item => ({
      scripCode: String(item.SCRIP_CD || 'N/A'),
      companyName: item.SLONGNAME || item.NEWSSUB || 'BSE Company',
      title: item.NEWSSUB || item.HEADLINE || '',
      pdfLink: item.ATTACHMENTNAME ? `https://www.bseindia.com/xml-data/corpnotice/attachment/data/${item.ATTACHMENTNAME}` : '',
      category: item.CATEGORYNAME || 'Other',
      timestamp: item.NEWS_DT || new Date().toISOString()
    }));

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

    const cachedRaw = await env.BSE_STORE.get('latest_announcements');
    const cached = cachedRaw ? JSON.parse(cachedRaw) : [];
    
    // Store latest processed dataset
    const listToStore = newAnnouncements.length > 0 ? [...newAnnouncements, ...cached] : items;
    const updated = listToStore.slice(0, 500);

    await env.BSE_STORE.put('latest_announcements', JSON.stringify(updated), { expirationTtl: 172800 });

    return items.length;
  } catch (err) {
    console.error("Error fetching BSE announcements:", err);
    return 0;
  }
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