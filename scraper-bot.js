// scraper-bot.js - نسخه نهایی (با قابلیت آپدیت قسمت‌های جدید)
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');

// --- تنظیمات ---
const API_BASE_URL = 'https://cinemaplus-app.vercel.app';
const SECRET_PHRASE = process.env.DB_SECRET; 

if (!SECRET_PHRASE) {
    console.error("❌ Error: DB_SECRET is missing!");
    process.exit(1);
}

const ARCHIVE_FILE = 'archive.enc';
const UPDATES_FILE = 'updates.json';

// ⚠️ مهم: چون آرشیو را داری، این را false گذاشتم
const IS_FIRST_RUN = false; 
const CONCURRENCY_LIMIT = 15; 

const TARGET_ENDPOINTS = [
    // فیلم‌ها (تکراری‌ها اسکیپ می‌شوند)
    { url: '/api/movies/new', type: 'movie', name: 'سینمایی جدید', maxPages: 1000 },
    { url: '/api/movies/top-rated', type: 'movie', name: 'سینمایی برتر', maxPages: 1000 },
    
    // سریال‌ها
    { url: '/api/series/new', type: 'series', name: 'سریال جدید', maxPages: 1000 },
    
    // ⚡️ نکته مهم: forceUpdate را برای این دسته true کردیم تا قسمت‌های جدید را بگیرد
    { url: '/api/series/updated', type: 'series', name: 'سریال آپدیت شده', maxPages: 1000, forceUpdate: true },
    
    { url: '/api/series/top-rated', type: 'series', name: 'سریال برتر', maxPages: 1000 }
];

const client = axios.create({
    baseURL: API_BASE_URL,
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
});

function getKey() {
    return crypto.createHash('sha256').update(String(SECRET_PHRASE)).digest();
}

function compressAndEncrypt(data) {
    const jsonString = JSON.stringify(data);
    const compressedBuffer = zlib.gzipSync(jsonString);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', getKey(), iv);
    let encrypted = cipher.update(compressedBuffer);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptAndDecompress(text) {
    try {
        const textParts = text.split(':');
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', getKey(), iv);
        let decryptedBuffer = decipher.update(encryptedText);
        decryptedBuffer = Buffer.concat([decryptedBuffer, decipher.final()]);
        const decompressedBuffer = zlib.gunzipSync(decryptedBuffer);
        return decompressedBuffer.toString('utf8');
    } catch (error) { return null; }
}

async function fetchSeasons(seriesId) {
    try { const { data } = await client.get(`/api/seasons/${seriesId}`); return data; } catch (error) { return null; }
}

async function processItems(items, config, existingIdsSet) {
    const processed = [];
    const seriesQueue = [];

    for (const item of items) {
        const myId = `plus_${item.id}`;
        
        // اگر forceUpdate نباشد و تکراری باشد، رد کن
        // اما اگر forceUpdate باشد (بخش آپدیت شده)، حتی اگر تکراری بود، دوباره بگیر (برای قسمت‌های جدید)
        if (!config.forceUpdate && existingIdsSet.has(myId)) continue;

        const cleanItem = {
            id: myId, real_id: item.id, title: item.title, image: item.image, year: item.year, imdb: item.imdb,
            description: item.description, itemType: config.type, sources: item.sources || [], seasons: null 
        };
        
        // فقط اگر آیتم جدید است به لیست IDها اضافه کن (در حالت آپدیت اجباری، ID از قبل هست)
        if (!existingIdsSet.has(myId)) existingIdsSet.add(myId);
        
        processed.push(cleanItem);
        if (config.type === 'series') seriesQueue.push(cleanItem);
    }

    if (seriesQueue.length > 0) {
        for (let i = 0; i < seriesQueue.length; i += CONCURRENCY_LIMIT) {
            const batch = seriesQueue.slice(i, i + CONCURRENCY_LIMIT);
            await Promise.all(batch.map(async (seriesItem) => {
                const seasonData = await fetchSeasons(seriesItem.real_id);
                if (seasonData) seriesItem.seasons = seasonData;
            }));
        }
    }
    return processed;
}

async function scrapeCategory(endpointConfig, existingIdsSet) {
    let categoryItems = [];
    // در حالت عادی فقط 5 صفحه چک می‌شود
    const maxPages = IS_FIRST_RUN ? endpointConfig.maxPages : 5;
    
    console.log(`\n🌐 Checking: ${endpointConfig.name}`);
    for (let page = 0; page < maxPages; page++) {
        try {
            const { data } = await client.get(`${endpointConfig.url}?page=${page}`);
            const results = data.posters || data.search_results || data;
            if (!results || results.length === 0) break;
            
            const processedPage = await processItems(results, endpointConfig, existingIdsSet);
            
            // در حالت forceUpdate ما همه را دوباره می‌گیریم، پس شرط "هیچ آیتم جدیدی نیست" را برمی‌داریم
            // اما در بقیه حالت‌ها اگر تکراری بود قطع می‌کنیم
            if (processedPage.length === 0 && !endpointConfig.forceUpdate) {
                if (!IS_FIRST_RUN) {
                    console.log("   No new items found here. Skipping rest.");
                    break; 
                }
            }
            
            // فقط اگر واقعاً جدید بود یا آپدیت شده بود اضافه کن
            if (processedPage.length > 0) {
                categoryItems.push(...processedPage);
                console.log(`   Page ${page + 1}: Processed ${processedPage.length} items.`);
            } else {
                process.stdout.write(`   Page ${page + 1}: All Skipped \r`);
            }
        } catch (error) { break; }
    }
    return categoryItems;
}

async function main() {
    console.log("🚀 Auto-Update Scraper Started...");

    let archive = [];
    let updates = [];

    if (fs.existsSync(ARCHIVE_FILE)) {
        try {
            const fileData = fs.readFileSync(ARCHIVE_FILE, 'utf8');
            const jsonStr = decryptAndDecompress(fileData);
            if (jsonStr) archive = JSON.parse(jsonStr);
        } catch (e) { console.log("Error reading archive."); }
    }
    if (fs.existsSync(UPDATES_FILE)) {
        updates = JSON.parse(fs.readFileSync(UPDATES_FILE, 'utf8'));
    }

    const existingIds = new Set([...archive, ...updates].map(i => i.id));
    let totalAddedOrUpdated = 0;

    for (const endpoint of TARGET_ENDPOINTS) {
        const fetchedItems = await scrapeCategory(endpoint, existingIds);
        
        if (fetchedItems.length > 0) {
            for (const item of fetchedItems) {
                // اگر آیتم قبلاً در آپدیت‌ها بوده، جایگزینش کن (آپدیت کن)
                const existingUpdateIndex = updates.findIndex(u => u.id === item.id);
                if (existingUpdateIndex > -1) {
                    updates[existingUpdateIndex] = item; // جایگزینی
                } else {
                    // اگر در آرشیو بوده اما الان آپدیت شده، باید بیاد توی لیست آپدیت‌ها
                    updates.unshift(item);
                }
            }
            totalAddedOrUpdated += fetchedItems.length;
        }
    }

    console.log(`\n🎉 Processed ${totalAddedOrUpdated} items.`);

    // حد نصاب 1000 تایی برای ادغام با آرشیو اصلی (کاهش دانلود کاربر)
    if (updates.length > 1000) {
        console.log("📦 Updates > 1000. Merging into Archive...");
        // حذف تکراری‌ها از آرشیو (چون ممکنه آیتم آپدیت شده الان بره تو آرشیو)
        const updateIds = new Set(updates.map(u => u.id));
        archive = archive.filter(item => !updateIds.has(item.id));
        
        // انتقال به آرشیو
        archive = [...updates, ...archive];
        updates = [];
    }

    // ذخیره
    if (totalAddedOrUpdated > 0) {
        console.log("💾 Saving changes...");
        fs.writeFileSync(ARCHIVE_FILE, compressAndEncrypt(archive));
        fs.writeFileSync(UPDATES_FILE, JSON.stringify(updates));
        console.log("✅ Done.");
    } else {
        console.log("💤 No changes.");
    }
}

main();
