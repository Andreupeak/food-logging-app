// server.js (single-file backend - CommonJS)
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

const { OpenAI } = require('openai');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve frontend static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// Multer for file uploads (used by test frontend)
const upload = multer({ storage: multer.memoryStorage() });

// Config / keys (from .env)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SPOONACULAR_KEY = process.env.SPOONACULAR_KEY;
const EDAMAM_NUTRITION_ID = process.env.EDAMAM_NUTRITION_ID;
const EDAMAM_NUTRITION_KEY = process.env.EDAMAM_NUTRITION_KEY;
const EDAMAM_FOOD_ID = process.env.EDAMAM_FOOD_ID;
const EDAMAM_FOOD_KEY = process.env.EDAMAM_FOOD_KEY;
const FATSECRET_CLIENT_ID = process.env.FATSECRET_CLIENT_ID;
const FATSECRET_CLIENT_SECRET = process.env.FATSECRET_CLIENT_SECRET;

// ---------- Helpers ----------
function stripBase64Prefix(b64) {
  if (!b64) return b64;
  const idx = b64.indexOf('base64,');
  return idx >= 0 ? b64.slice(idx + 7) : b64;
}
function bufferToDataUrl(buffer, mime = 'image/jpeg') {
  const base64 = buffer.toString('base64');
  return `data:${mime};base64,${base64}`;
}

// ---------- OpenAI Vision (recognition) ----------
async function analyzeWithOpenAI(imageBase64) {
  try {
    const base64Only = stripBase64Prefix(imageBase64);
    const dataUrl = `data:image/jpeg;base64,${base64Only}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: dataUrl }
            },
            {
              type: "text",
              text: "Identify the primary food or dish in this image. Reply with a short name only, e.g. 'chicken curry with rice'. No extra explanation."
            }
          ]
        }
      ],
      temperature: 0.0
    });

    const text = (response.choices[0]?.message?.content || "").trim();
    if (!text) throw new Error('Empty recognition result from OpenAI');
    return text;
  } catch (err) {
    console.error('OpenAI Vision error:', err.message || err);
    throw new Error('OpenAI Vision failed: ' + (err.message || err));
  }
}

// ---------- OpenAI Nutrition (Tab 6 uses image -> nutrition) ----------
async function getNutritionFromOpenAIImage(imageBase64) {
  try {
    const base64Only = stripBase64Prefix(imageBase64);
    const dataUrl = `data:image/jpeg;base64,${base64Only}`;

    const instruction = `You will be given a food image. Identify the dish and visible ingredients, then estimate nutrition values PER 100g for: calories, protein (g), carbs (g), fat (g).
Return strictly valid JSON with these keys:
{ "foodName": "short name", "calories": number, "protein": number, "carbs": number, "fat": number }
Round numbers to one decimal place (or integer for calories).
If unsure, make a reasonable estimate.`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: dataUrl }
            },
            {
              type: "text",
              text: instruction
            }
          ]
        }
      ],
      temperature: 0.0
    });

    const out = response.choices[0]?.message?.content || '';
    const first = out.indexOf('{');
    const last = out.lastIndexOf('}');
    if (first < 0 || last < 0) throw new Error('OpenAI nutrition output not JSON: ' + out);
    const jsonText = out.slice(first, last + 1);
    const parsed = JSON.parse(jsonText);
    return parsed;
  } catch (err) {
    console.error('OpenAI Nutrition (image) error:', err.message || err);
    throw new Error('OpenAI Nutrition image analysis failed: ' + (err.message || err));
  }
}

// ---------- Nutrition provider helpers ----------

// Tab 1: Edamam Nutrition Analysis API (nutrition-data)
async function getNutritionEdamam1(foodName) {
  try {
    const res = await axios.get('https://api.edamam.com/api/nutrition-data', {
      params: {
        app_id: EDAMAM_NUTRITION_ID,
        app_key: EDAMAM_NUTRITION_KEY,
        nutrition_type: 'logging',
        query: foodName
      }
    });
    const data = res.data || {};
    const calories = data.calories || 0;
    const total = data.totalNutrients || {};
    const protein = (total.PROCNT && total.PROCNT.quantity) || 0;
    const carbs = (total.CHOCDF && total.CHOCDF.quantity) || 0;
    const fat = (total.FAT && total.FAT.quantity) || 0;
    return { calories, protein, carbs, fat };
  } catch (err) {
    console.error('Edamam Nutrition error:', err.response?.data || err.message || err);
    throw new Error('Edamam Nutrition failed');
  }
}

// Tab 2: Edamam Food Database (parser)
async function getNutritionEdamam2(foodName) {
  try {
    const res = await axios.get('https://api.edamam.com/api/food-database/v2/parser', {
      params: {
        app_id: EDAMAM_FOOD_ID,
        app_key: EDAMAM_FOOD_KEY,
        ingr: foodName
      }
    });
    const data = res.data || {};
    const food = (data.parsed && data.parsed[0] && data.parsed[0].food) || (data.hints && data.hints[0] && data.hints[0].food);
    if (!food) throw new Error('Food not found in Edamam Food DB');
    const n = food.nutrients || {};
    return {
      calories: n.ENERC_KCAL || 0,
      protein: n.PROCNT || 0,
      carbs: n.CHOCDF || 0,
      fat: n.FAT || 0
    };
  } catch (err) {
    console.error('Edamam FoodDB error:', err.response?.data || err.message || err);
    throw new Error('Edamam FoodDB failed');
  }
}

// Tab 3: FatSecret
async function getNutritionFatSecret(foodName) {
  try {
    const params = new URLSearchParams();
    params.append('client_id', FATSECRET_CLIENT_ID);
    params.append('client_secret', FATSECRET_CLIENT_SECRET);
    params.append('grant_type', 'client_credentials');

    const tokenRes = await axios.post('https://oauth.fatsecret.com/connect/token', params);
    const token = tokenRes.data && tokenRes.data.access_token;
    if (!token) throw new Error('FatSecret token failed');

    const searchRes = await axios.get('https://platform.fatsecret.com/rest/server.api', {
      params: { method: 'foods.search', search_expression: foodName, format: 'json' },
      headers: { Authorization: `Bearer ${token}` }
    });

    const foods = searchRes.data && (searchRes.data.foods || searchRes.data.food);
    let firstFood;
    if (foods) {
      if (Array.isArray(foods.food)) firstFood = foods.food[0];
      else firstFood = foods.food || foods[0];
    }
    if (!firstFood) throw new Error('FatSecret: no food found');

    const foodId = firstFood.food_id || firstFood.id;
    const detailRes = await axios.get('https://platform.fatsecret.com/rest/server.api', {
      params: { method: 'food.get_v2', food_id: foodId, format: 'json' },
      headers: { Authorization: `Bearer ${token}` }
    });

    const foodDetail = detailRes.data && detailRes.data.food;
    const serving = foodDetail && (foodDetail.servings && foodDetail.servings.serving && foodDetail.servings.serving[0]);
    if (!serving) throw new Error('FatSecret: no serving info');

    return {
      calories: parseFloat(serving.calories) || 0,
      protein: parseFloat(serving.protein) || 0,
      carbs: parseFloat(serving.carbohydrate) || 0,
      fat: parseFloat(serving.fat) || 0
    };

  } catch (err) {
    console.error('FatSecret error:', err.response?.data || err.message || err);
    throw new Error('FatSecret failed');
  }
}

// Tab 4: OpenFoodFacts
async function getNutritionOpenFoodFacts(foodName) {
  try {
    const res = await axios.get('https://world.openfoodfacts.org/cgi/search.pl', {
      params: { search_terms: foodName, search_simple: 1, action: 'process', json: 1, page_size: 1 }
    });
    const product = res.data && res.data.products && res.data.products[0];
    if (!product) throw new Error('OpenFoodFacts: not found');
    const n = product.nutriments || {};
    return {
      calories: n['energy-kcal'] || n['energy_kcal'] || 0,
      protein: n.proteins || 0,
      carbs: n.carbohydrates || 0,
      fat: n.fat || 0
    };
  } catch (err) {
    console.error('OpenFoodFacts error:', err.response?.data || err.message || err);
    throw new Error('OpenFoodFacts failed');
  }
}

// Tab 5: Spoonacular (nutrition estimation)
async function getNutritionSpoonacular(foodName) {
  try {
    const guessRes = await axios.get('https://api.spoonacular.com/recipes/guessNutrition', {
      params: { title: foodName, apiKey: SPOONACULAR_KEY }
    });

    if (guessRes.data && (guessRes.data.calories || guessRes.data.calories === 0)) {
      const parseVal = v => {
        if (!v) return 0;
        if (typeof v === 'number') return v;
        if (v.value !== undefined) return parseFloat(v.value);
        if (v.amount !== undefined) return parseFloat(v.amount);
        return 0;
      };
      return {
        calories: parseVal(guessRes.data.calories),
        protein: parseVal(guessRes.data.protein),
        carbs: parseVal(guessRes.data.carbs),
        fat: parseVal(guessRes.data.fat)
      };
    }

    const searchRes = await axios.get('https://api.spoonacular.com/food/ingredients/search', {
      params: { query: foodName, number: 1, apiKey: SPOONACULAR_KEY }
    });

    const results = (searchRes.data && searchRes.data.results) || [];
    if (!results.length) throw new Error('Spoonacular: ingredient not found');

    const ingredientId = results[0].id;
    const infoRes = await axios.get(`https://api.spoonacular.com/food/ingredients/${ingredientId}/information`, {
      params: { amount: 100, unit: 'g', apiKey: SPOONACULAR_KEY }
    });

    const nutr = infoRes.data && infoRes.data.nutrition && infoRes.data.nutrition.nutrients;
    const find = (name) => {
      const n = (nutr || []).find(x => x.name && x.name.toLowerCase().includes(name));
      return n ? n.amount : 0;
    };

    return {
      calories: find('calories') || 0,
      protein: find('protein') || 0,
      carbs: find('carbohydrate') || 0,
      fat: find('fat') || 0
    };

  } catch (err) {
    console.error('Spoonacular error:', err.response?.data || err.message || err);
    throw new Error('Spoonacular failed: ' + (err.response?.data?.message || err.message));
  }
}

// Tab 6 by name (fallback: get nutrition by name via OpenAI)
async function getNutritionFromOpenAIByName(foodName) {
  try {
    const prompt = `Provide nutrition estimates PER 100g for "${foodName}".
Return strictly valid JSON:
{ "calories": number, "protein": number, "carbs": number, "fat": number }
Round numbers to one decimal place.`;
    
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.0
    });
    
    const out = resp.choices[0]?.message?.content || '';
    const first = out.indexOf('{'), last = out.lastIndexOf('}');
    if (first < 0 || last < 0) throw new Error('OpenAI nutrition response not JSON');
    const jsonText = out.slice(first, last + 1);
    return JSON.parse(jsonText);
  } catch (err) {
    console.error('OpenAI nutrition by name error:', err.message || err);
    throw new Error('OpenAI nutrition lookup failed');
  }
}

// ---------- Routes ----------

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// POST /api/openai/vision - FormData file upload (test UI uses this)
app.post('/api/openai/vision', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Missing file' });
    const dataUrl = bufferToDataUrl(req.file.buffer, req.file.mimetype || 'image/jpeg');
    const foodName = await analyzeWithOpenAI(dataUrl);
    res.json({ foodName });
  } catch (err) {
    console.error('Vision endpoint error:', err.message || err);
    res.status(500).json({ error: err.message || 'Vision failed' });
  }
});

// GET /api/nutrition/:tab?q=foodName - call provider by name
app.get('/api/nutrition/:tab', async (req, res) => {
  try {
    const tab = Number(req.params.tab);
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'Missing query param q (food name)' });

    let nutrition;
    switch (tab) {
      case 1: nutrition = await getNutritionEdamam1(q); break;
      case 2: nutrition = await getNutritionEdamam2(q); break;
      case 3: nutrition = await getNutritionFatSecret(q); break;
      case 4: nutrition = await getNutritionOpenFoodFacts(q); break;
      case 5: nutrition = await getNutritionSpoonacular(q); break;
      case 6: nutrition = await getNutritionFromOpenAIByName(q); break;
      default: return res.status(400).json({ error: 'Invalid tab (1-6)' });
    }

    res.json({ foodName: q, nutrition });
  } catch (err) {
    console.error('Nutrition endpoint error:', err.message || err);
    res.status(500).json({ error: err.message || 'Nutrition lookup failed' });
  }
});

// POST /api/analyze-image - entire flow (image + tab)
app.post('/api/analyze-image', async (req, res) => {
  try {
    const { image, tab } = req.body;
    if (!image || !tab) return res.status(400).json({ error: 'Missing image or tab' });

    const foodName = await analyzeWithOpenAI(image);

    if (Number(tab) === 6) {
      const openaiNutrition = await getNutritionFromOpenAIImage(image);
      if (!openaiNutrition.foodName) openaiNutrition.foodName = foodName;
      return res.json({ foodName, nutrition: openaiNutrition });
    }

    let nutrition;
    switch (Number(tab)) {
      case 1: nutrition = await getNutritionEdamam1(foodName); break;
      case 2: nutrition = await getNutritionEdamam2(foodName); break;
      case 3: nutrition = await getNutritionFatSecret(foodName); break;
      case 4: nutrition = await getNutritionOpenFoodFacts(foodName); break;
      case 5: nutrition = await getNutritionSpoonacular(foodName); break;
      default: return res.status(400).json({ error: 'Invalid tab (must be 1-6)' });
    }

    return res.json({ foodName, nutrition });

  } catch (err) {
    console.error('Analyze-image endpoint error:', err.message || err);
    return res.status(500).json({ error: err.message || 'Failed to analyze image' });
  }
});

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
