// server.js (CommonJS)
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const FormData = require('form-data');
require('dotenv').config();

const { OpenAI } = require('openai');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Keys / config
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SPOONACULAR_KEY = process.env.SPOONACULAR_KEY;
const EDAMAM_NUTRITION_ID = process.env.EDAMAM_NUTRITION_ID;
const EDAMAM_NUTRITION_KEY = process.env.EDAMAM_NUTRITION_KEY;
const EDAMAM_FOOD_ID = process.env.EDAMAM_FOOD_ID;
const EDAMAM_FOOD_KEY = process.env.EDAMAM_FOOD_KEY;
const FATSECRET_CLIENT_ID = process.env.FATSECRET_CLIENT_ID;
const FATSECRET_CLIENT_SECRET = process.env.FATSECRET_CLIENT_SECRET;

// Helper: Extract base64 payload (strip data:...;base64, if present)
function stripBase64Prefix(b64) {
  if (!b64) return b64;
  const idx = b64.indexOf('base64,');
  return idx >= 0 ? b64.slice(idx + 7) : b64;
}

/**
 * OpenAI Vision: identify food name from image (returns short string).
 * We provide the base64 as a data URL (OpenAI accepts that form).
 */
async function analyzeWithOpenAI(imageBase64) {
  try {
    // Ensure data URL format for image_url
    const base64Only = stripBase64Prefix(imageBase64);
    const dataUrl = `data:image/jpeg;base64,${base64Only}`;

    // Ask OpenAI to return just the food name (short)
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      // Using the multimodal input pattern
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: dataUrl
            },
            {
              type: "text",
              text: "Identify the primary food or dish shown in this image. Reply with a short name only, e.g. 'chicken curry with rice'. No extra explanation."
            }
          ]
        }
      ],
      temperature: 0.0
    });

    // OpenAI SDK surfaces the composed text via output_text
    const text = (response.output_text || "").trim();
    if (!text) throw new Error('OpenAI returned empty recognition result');
    return text;
  } catch (err) {
    console.error('OpenAI Vision error:', err.message || err);
    throw new Error('OpenAI Vision failed: ' + (err.message || err));
  }
}

/**
 * OpenAI Nutrition (Tab 6): from image -> return JSON with foodName and macros per 100g
 */
async function getNutritionFromOpenAIImage(imageBase64) {
  try {
    const base64Only = stripBase64Prefix(imageBase64);
    const dataUrl = `data:image/jpeg;base64,${base64Only}`;

    const instruction = `
You will be given a food image. Identify the dish and visible ingredients, then estimate nutrition values PER 100g for: calories, protein (g), carbs (g), fat (g).
Return strictly valid JSON with these keys:
{
  "foodName": "short name",
  "calories": number,
  "protein": number,
  "carbs": number,
  "fat": number
}
Round numbers to one decimal place (or integer for calories).
If unsure, make a reasonable estimate.
`;

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_image", image_url: dataUrl },
            { type: "text", text: instruction }
          ]
        }
      ],
      temperature: 0.0
    });

    const out = response.output_text || '';
    // Try to parse JSON from the output (strip surrounding text)
    const firstBrace = out.indexOf('{');
    const lastBrace = out.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace < 0) {
      throw new Error('OpenAI nutrition response not JSON: ' + out);
    }
    const jsonText = out.slice(firstBrace, lastBrace + 1);
    const parsed = JSON.parse(jsonText);
    return parsed;
  } catch (err) {
    console.error('OpenAI Nutrition (image) error:', err.message || err);
    throw new Error('OpenAI Nutrition image analysis failed: ' + (err.message || err));
  }
}

/* -------------------------
   Nutrition provider helpers
   ------------------------- */

/* Tab 1: Edamam Nutrition Analysis API (nutrition-data)
   Note: this endpoint expects a 'query' that can be "1 cup rice" or "100g chicken".
   We'll pass the recognized foodName as query for a rough lookup.
*/
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
    // Response uses calories and totalNutrients keys
    const data = res.data || {};
    const calories = data.calories || 0;
    const totalNutrients = data.totalNutrients || {};
    const protein = (totalNutrients.PROCNT && totalNutrients.PROCNT.quantity) || 0;
    const carbs = (totalNutrients.CHOCDF && totalNutrients.CHOCDF.quantity) || 0;
    const fat = (totalNutrients.FAT && totalNutrients.FAT.quantity) || 0;
    return { calories, protein, carbs, fat };
  } catch (err) {
    console.error('Edamam Nutrition error:', err.response?.data || err.message || err);
    throw new Error('Edamam Nutrition failed');
  }
}

/* Tab 2: Edamam Food Database (parser) */
async function getNutritionEdamam2(foodName) {
  try {
    const res = await axios.get('https://api.edamam.com/api/food-database/v2/parser', {
      // some accounts use different path; this is the documented path
      params: {
        app_id: EDAMAM_FOOD_ID,
        app_key: EDAMAM_FOOD_KEY,
        ingr: foodName
      }
    });
    // The parser can return parsed or hints
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

/* Tab 3: FatSecret (OAuth client credentials -> food.search + food.get) */
async function getNutritionFatSecret(foodName) {
  try {
    const params = new URLSearchParams();
    params.append('client_id', FATSECRET_CLIENT_ID);
    params.append('client_secret', FATSECRET_CLIENT_SECRET);
    params.append('grant_type', 'client_credentials');

    const tokenRes = await axios.post('https://oauth.fatsecret.com/connect/token', params);
    const token = tokenRes.data && tokenRes.data.access_token;
    if (!token) throw new Error('FatSecret token failed');

    // search
    const searchRes = await axios.get('https://platform.fatsecret.com/rest/server.api', {
      params: { method: 'foods.search', search_expression: foodName, format: 'json' },
      headers: { Authorization: `Bearer ${token}` }
    });

    // API variations: try expected keys
    const foods = searchRes.data && (searchRes.data.foods || searchRes.data.food);
    let firstFood;
    if (foods) {
      if (Array.isArray(foods.food)) firstFood = foods.food[0];
      else firstFood = foods.food || foods[0];
    }
    if (!firstFood) throw new Error('FatSecret: no food found');

    const foodId = firstFood.food_id || firstFood.id;
    // details
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

/* Tab 4: OpenFoodFacts */
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

/* Tab 5: Spoonacular (keep it for testing)
   We'll call guessNutrition (recipes/guessNutrition) which expects a title,
   optionally use ingredients search as fallback.
*/
async function getNutritionSpoonacular(foodName) {
  try {
    // First try guessNutrition
    const guessRes = await axios.get('https://api.spoonacular.com/recipes/guessNutrition', {
      params: { title: foodName, apiKey: SPOONACULAR_KEY }
    });

    if (guessRes.data && (guessRes.data.calories || guessRes.data.calories === 0)) {
      // guessNutrition returns calories/protein/carbs/fat as objects with value/unit sometimes
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

    // Fallback: ingredient search -> get first result -> fetch nutrition via ingredient endpoint
    const searchRes = await axios.get('https://api.spoonacular.com/food/ingredients/search', {
      params: { query: foodName, number: 1, apiKey: SPOONACULAR_KEY }
    });

    const results = (searchRes.data && searchRes.data.results) || [];
    if (!results.length) throw new Error('Spoonacular: ingredient not found');

    const ingredientId = results[0].id;
    // Use ingredient information endpoint (example)
    const infoRes = await axios.get(`https://api.spoonacular.com/food/ingredients/${ingredientId}/information`, {
      params: { amount: 100, unit: 'g', apiKey: SPOONACULAR_KEY }
    });

    const nutr = infoRes.data && infoRes.data.nutrition && infoRes.data.nutrition.nutrients;
    // nutr is array; find relevant nutrients
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
    // log details when spoonacular returns non-200
    console.error('Spoonacular error:', err.response?.data || err.message || err);
    throw new Error('Spoonacular failed: ' + (err.response?.data?.message || err.message));
  }
}

/* Tab 6: OpenAI nutrition by food name (the user may prefer image-based JSON; we use image route above for full image)
   But also we provide function that accepts foodName (fallback) to give macros per 100g.
*/
async function getNutritionFromOpenAIByName(foodName) {
  try {
    const prompt = `
Provide nutrition estimates PER 100g for "${foodName}".
Return strictly valid JSON:
{ "calories": number, "protein": number, "carbs": number, "fat": number }
Round numbers to one decimal place (calories integer ok).
`;
    const resp = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.0
    });

    const out = resp.output_text || '';
    const firstBrace = out.indexOf('{'), lastBrace = out.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace < 0) throw new Error('OpenAI nutrition response not JSON');
    const jsonText = out.slice(firstBrace, lastBrace + 1);
    const parsed = JSON.parse(jsonText);
    return parsed;
  } catch (err) {
    console.error('OpenAI nutrition by name error:', err.message || err);
    throw new Error('OpenAI nutrition lookup failed');
  }
}

/* -------------------------
   Main endpoint: universal analyze
   ------------------------- */

/**
 * Request body:
 * {
 *   image: "<base64 data url or raw base64>",
 *   tab: 1..6
 * }
 */
app.post('/api/analyze-image', async (req, res) => {
  try {
    const { image, tab } = req.body;
    if (!image || !tab) return res.status(400).json({ error: 'Missing image or tab' });

    // Universal recognition with OpenAI Vision
    const foodName = await analyzeWithOpenAI(image);

    // Tab 6 special: full OpenAI (image -> nutrition estimated by OpenAI)
    if (Number(tab) === 6) {
      const openaiNutrition = await getNutritionFromOpenAIImage(image);
      // ensure foodName included
      if (!openaiNutrition.foodName) openaiNutrition.foodName = foodName;
      return res.json({ foodName, nutrition: openaiNutrition });
    }

    // For tabs 1-5 use specific nutrition providers
    let nutrition = {};
    switch (Number(tab)) {
      case 1:
        nutrition = await getNutritionEdamam1(foodName);
        break;
      case 2:
        nutrition = await getNutritionEdamam2(foodName);
        break;
      case 3:
        nutrition = await getNutritionFatSecret(foodName);
        break;
      case 4:
        nutrition = await getNutritionOpenFoodFacts(foodName);
        break;
      case 5:
        nutrition = await getNutritionSpoonacular(foodName);
        break;
      default:
        return res.status(400).json({ error: 'Invalid tab (must be 1-6)' });
    }

    return res.json({
      foodName,
      nutrition
    });

  } catch (err) {
    console.error('Analyze-image endpoint error:', err.message || err);
    // Send helpful message but avoid leaking secrets
    return res.status(500).json({ error: err.message || 'Failed to analyze image' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
