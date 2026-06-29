const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let supabase;
if (SUPABASE_URL && SUPABASE_SECRET_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
}

const adminAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader === ADMIN_PASSWORD) {
    return next();
  }
  return res.status(401).json({ error: "Unauthorized. Galat password!" });
};

function sanitizeShortener(dashUrl, apiKey) {
  let cleanUrl = (dashUrl || "").trim();
  let cleanKey = (apiKey || "").trim();
  try {
    if (!/^https?:\/\//i.test(cleanUrl)) {
      cleanUrl = "https://" + cleanUrl;
    }
    const parsed = new URL(cleanUrl);
    cleanUrl = parsed.hostname; 
  } catch (e) {
    cleanUrl = cleanUrl.replace(/^(https?:\/\/|https?\/|https?:|http?:)/i, "");
    cleanUrl = cleanUrl.split('/')[0];
  }
  return { cleanUrl: cleanUrl.replace(/\s+/g, ""), cleanKey: cleanKey.replace(/\s+/g, "") };
}

function appendRandomParam(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("_c", Math.random().toString(36).substring(2, 9) + Date.now().toString().slice(-5));
    return parsed.toString();
  } catch (e) {
    const separator = url.includes("?") ? "&" : "?";
    return url + separator + "_c=" + Math.random().toString(36).substring(2, 9) + Date.now().toString().slice(-5);
  }
}

async function cleanExpiredPremiumUsers() {
  if (!supabase) return;
  try {
    const now = new Date().toISOString();
    await supabase.from("premium_users").delete().lt("expires_at", now);
  } catch (err) {
    console.error("Cleanup error:", err.message);
  }
}

async function fetchShortlink(cleanUrl, cleanKey, originalLink, uniqueOriginalLink) {
  if (cleanUrl.toLowerCase().includes("bitly")) {
    try {
      const response = await fetch("https://api-ssl.bitly.com/v4/shorten", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${cleanKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ long_url: uniqueOriginalLink })
      });
      if (response.ok) {
        const data = await response.json();
        if (data && data.link && data.link.toLowerCase().trim() !== originalLink.toLowerCase().trim()) {
          return data.link;
        }
      }
    } catch (err) {
      console.error("Bitly shortening failed:", err.message);
    }
    return null;
  }

  const domainsToTry = [cleanUrl];
  if (!cleanUrl.startsWith("api.") && !cleanUrl.startsWith("www.")) {
    domainsToTry.push("api." + cleanUrl);
  }

  for (const domain of domainsToTry) {
    const apiUrl = `https://${domain}/api?api=${cleanKey}&url=${encodeURIComponent(uniqueOriginalLink)}`;
    try {
      const response = await fetch(apiUrl, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          "Accept": "application/json, text/plain, */*"
        },
        timeout: 5000 
      });
      if (response.ok) {
        const text = await response.text();
        let shortLink = "";
        try {
          const json = JSON.parse(text);
          if (json.status === "success" || !json.status || json.status === 200) {
            shortLink = json.shortenedUrl || json.short_url || json.url || json.link || "";
          }
        } catch (e) {
          if (text.startsWith("http://") || text.startsWith("https://")) {
            shortLink = text.trim();
          }
        }
        if (shortLink && shortLink.startsWith("http") && shortLink.toLowerCase().trim() !== originalLink.toLowerCase().trim()) {
          return shortLink;
        }
      }
    } catch (err) {
      console.error(`Shortener error on domain: ${domain}`, err.message);
    }
  }
  return null;
}

const router = express.Router();

router.get("/posts", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { search } = req.query;
  let query = supabase.from("posts").select("*").order("created_at", { ascending: false });
  if (search) {
    query = query.ilike("name", `%${search}%`);
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get("/episodes/:postId", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { data, error } = await supabase
    .from("episodes")
    .select("id, post_id, episode_label")
    .eq("post_id", req.params.postId)
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get("/settings", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database not connected" });
  const { data, error } = await supabase.from("settings").select("channel_link, group_link").eq("id", 1).single();
  if (error && error.code !== "PGRST116") return res.status(500).json({ error: error.message });
  res.json(data || { channel_link: "", group_link: "" });
});

router.post("/admin/login", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true });
  }
  return res.status(401).json({ error: "Galat Password!" });
});

router.post("/admin/add-post", adminAuth, async (req, res) => {
  try {
    const { name, image_url, release_date, genres, season, short_story, category } = req.body;
    const { data: postData, error: dbError } = await supabase.from("posts").insert({
      name, image_url, release_date, genres, season, short_story, category
    }).select();
    if (dbError) throw dbError;
    res.json({ success: true, post: postData[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/admin/posts", adminAuth, async (req, res) => {
  const { search } = req.query;
  let query = supabase.from("posts").select("*").order("created_at", { ascending: false });
  if (search) {
    query = query.ilike("name", `%${search}%`);
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post("/admin/add-episode", adminAuth, async (req, res) => {
  let { post_id, episode_label, original_link, play_link } = req.body;
  const { data, error } = await supabase.from("episodes").insert({ 
    post_id, episode_label, original_link: (original_link || "").trim(), play_link: (play_link || "").trim() 
  }).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

router.post("/admin/delete-post", adminAuth, async (req, res) => {
  const { post_id } = req.body;
  const { data: post } = await supabase.from("posts").select("image_url").eq("id", post_id).single();
  if (post && post.image_url) {
    const fileName = post.image_url.split("/").pop();
    await supabase.storage.from("Post-images").remove([fileName]);
  }
  const { error } = await supabase.from("posts").delete().eq("id", post_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.get("/admin/episodes/:postId", adminAuth, async (req, res) => {
  const { data, error } = await supabase.from("episodes").select("*").eq("post_id", req.params.postId).order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post("/admin/delete-episode", adminAuth, async (req, res) => {
  const { episode_id } = req.body;
  const { error } = await supabase.from("episodes").delete().eq("id", episode_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.get("/admin/shorteners", adminAuth, async (req, res) => {
  const { data, error } = await supabase.from("shorteners").select("*");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post("/admin/add-shortener", adminAuth, async (req, res) => {
  const { dashboard_url, api_key } = req.body;
  const { count } = await supabase.from("shorteners").select("*", { count: "exact" });
  if (count >= 3) {
    return res.status(400).json({ error: "Maximum 3 shorteners are allowed!" });
  }
  const { cleanUrl, cleanKey } = sanitizeShortener(dashboard_url, api_key);
  const { data, error } = await supabase.from("shorteners").insert({ dashboard_url: cleanUrl, api_key: cleanKey }).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

router.post("/admin/delete-shortener", adminAuth, async (req, res) => {
  const { id } = req.body;
  const { error } = await supabase.from("shorteners").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.get("/admin/settings", adminAuth, async (req, res) => {
  const { data, error } = await supabase.from("settings").select("*").eq("id", 1).single();
  if (error && error.code !== "PGRST116") return res.status(500).json({ error: error.message });
  res.json(data || { channel_link: "", group_link: "", player_password: "" });
});

router.post("/admin/save-settings", adminAuth, async (req, res) => {
  const { channel_link, group_link, player_password } = req.body;
  const { error } = await supabase.from("settings").upsert({ id: 1, channel_link, group_link, player_password });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.get("/admin/premium-users", adminAuth, async (req, res) => {
  await cleanExpiredPremiumUsers();
  const { data, error } = await supabase.from("premium_users").select("*").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post("/admin/add-premium", adminAuth, async (req, res) => {
  const { username, password } = req.body;
  const expires_at = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from("premium_users").upsert({ 
    username, password, expires_at, session_token: "" 
  }, { onConflict: "username" });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, expires_at });
});

router.post("/admin/delete-premium", adminAuth, async (req, res) => {
  const { id } = req.body;
  const { error } = await supabase.from("premium_users").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.get("/shorten", async (req, res) => {
  const { ep_id, post_name, ep_label } = req.query;
  try {
    let ep = null;
    if (ep_id) {
      const { data } = await supabase.from("episodes").select("original_link").eq("id", ep_id).single();
      ep = data;
    } else if (post_name && ep_label) {
      const { data: post } = await supabase.from("posts").select("id").ilike("name", post_name.trim()).single();
      if (post) {
        const { data } = await supabase.from("episodes").select("original_link").eq("post_id", post.id).ilike("episode_label", ep_label.trim()).single();
        ep = data;
      }
    }
    if (!ep || !ep.original_link) {
      return res.json({ error: "Download link uplabdh nahi hai." });
    }
    const originalLink = ep.original_link;
    const uniqueOriginalLink = appendRandomParam(originalLink);

    const { data: shorteners } = await supabase.from("shorteners").select("*");
    if (!shorteners || shorteners.length === 0) {
      return res.json({ error: "Koi active shortener account configured nahi hai." });
    }
    const shuffledShorteners = [...shorteners].sort(() => Math.random() - 0.5);
    let shortLink = null;
    for (const rawShortener of shuffledShorteners) {
      const { cleanUrl, cleanKey } = sanitizeShortener(rawShortener.dashboard_url, rawShortener.api_key);
      shortLink = await fetchShortlink(cleanUrl, cleanKey, originalLink, uniqueOriginalLink);
      if (shortLink && shortLink.startsWith("http")) break;
    }
    if (shortLink && shortLink.startsWith("http")) {
      res.json({ shortLink });
    } else {
      res.json({ error: "Shortener response failed." });
    }
  } catch (err) {
    res.json({ error: "Shortener API error: " + err.message });
  }
});

router.post("/verify-player", async (req, res) => {
  const { password, post_name, ep_label, ep_id } = req.body;
  try {
    const { data: settings } = await supabase.from("settings").select("player_password").eq("id", 1).single();
    if (settings?.player_password && password !== settings.player_password) {
      return res.status(401).json({ error: "Streaming password galat hai!" });
    }
    let ep = null;
    if (ep_id) {
      const { data } = await supabase.from("episodes").select("play_link").eq("id", ep_id).single();
      ep = data;
    }
    if (!ep || !ep.play_link) {
      return res.status(404).json({ error: "Stream link nahi mila." });
    }
    const streamToken = Buffer.from(ep.play_link).toString("base64");
    res.json({ success: true, token: streamToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/play-stream", (req, res) => {
  const { t, title } = req.query;
  if (!t) return res.status(400).send("Access Token Missing.");
  const originalUrl = Buffer.from(t, "base64").toString("ascii");
  const videoTitle = title ? decodeURIComponent(title) : "Anime Streaming";
  const isEmbed = originalUrl.includes("embed") || originalUrl.includes("/e/") || originalUrl.includes("dood") || originalUrl.includes("streamwish") || originalUrl.includes("filemoon") || originalUrl.includes("streamtape") || originalUrl.includes("mixdrop");

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${videoTitle}</title>
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
      <style>
        body { margin: 0; padding: 0; background-color: #060608; color: #fff; font-family: sans-serif; display: flex; flex-direction: column; min-height: 100vh; justify-content: space-between; align-items: center; }
        .container { width: 100%; max-width: 960px; padding: 20px; box-sizing: border-box; }
        .back-bar { display: flex; align-items: center; width: 100%; margin-bottom: 15px; }
        .back-btn { background: none; border: none; color: #e50914; font-size: 16px; cursor: pointer; text-decoration: none; font-weight: bold; display: flex; align-items: center; gap: 8px; }
        .back-btn:hover { color: #fff; }
        .title { font-size: 1.3rem; font-weight: bold; margin-left: 20px; text-shadow: 0 0 10px rgba(229, 9, 20, 0.4); }
        .player-wrapper { position: relative; width: 100%; aspect-ratio: 16/9; background: #000; border-radius: 12px; overflow: hidden; border: 1px solid rgba(229, 9, 20, 0.3); }
        iframe, video { width: 100%; height: 100%; border: none; object-fit: contain; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="back-bar">
          <button class="back-btn" onclick="window.close()"><i class="fa-solid fa-arrow-left"></i> Close Player</button>
          <span class="title">${videoTitle}</span>
        </div>
        <div class="player-wrapper">
          \${isEmbed ? \`
            <iframe src="\${originalUrl}" allowfullscreen="true" scrolling="no" allow="autoplay; encrypted-media"></iframe>
          \` : \`
            <video controls autoplay>
              <source src="\${originalUrl}" type="video/mp4">
            </video>
          \`}
        </div>
      </div>
    </body>
    </html>
  `);
});

router.post("/premium-login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Details missing" });
  try {
    const { data: user, error } = await supabase
      .from("premium_users")
      .select("*")
      .eq("username", username)
      .eq("password", password)
      .single();

    if (error || !user) return res.status(401).json({ error: "Galat Gmail ya Password!" });
    if (new Date(user.expires_at) < new Date()) {
      return res.status(401).json({ error: "Aapka premium expire ho chuka hai!" });
    }

    const newSessionToken = uuidv4();
    await supabase
      .from("premium_users")
      .update({ session_token: newSessionToken })
      .eq("id", user.id);

    res.json({ success: true, username: user.username, session_token: newSessionToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Premium multi-device detect system and automatic user profile destroy block
router.post("/premium-bypass", async (req, res) => {
  const { username, session_token, post_name, ep_label, ep_id } = req.body;
  if (!username || !session_token) return res.status(401).json({ error: "Aap logged in nahi hain!" });
  try {
    const { data: user, error } = await supabase
      .from("premium_users")
      .select("*")
      .eq("username", username)
      .single();

    if (error || !user) return res.status(401).json({ error: "Aap premium user nahi hain!" });
    if (new Date(user.expires_at) < new Date()) {
      return res.status(401).json({ error: "Premium trial limit expire ho chuki hai!" });
    }

    // Double login system trigger: Agat token mismatch hua, toh database se user profile destroy karke dono ko terminate karenge
    if (user.session_token !== session_token) {
      await supabase.from("premium_users").delete().eq("id", user.id);
      return res.status(403).json({ 
        error: "Double Login Alert! Ek hi premium ID dusre device par active hone ke karan aapka Premium account permanently block aur delete kar diya gaya hai!" 
      });
    }

    let ep = null;
    if (ep_id) {
      const { data } = await supabase.from("episodes").select("original_link").eq("id", ep_id).single();
      ep = data;
    }
    if (!ep || !ep.original_link) {
      return res.status(404).json({ error: "Is episode ke liye Download Link uplabdh nahi hai!" });
    }
    res.json({ success: true, original_link: ep.original_link });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use("/api", router);
app.use("/", router);

module.exports = app;
