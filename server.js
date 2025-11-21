const express = require('express');
const axios = require('axios');
const cors = require('cors');
const FormData = require('form-data');
const Buffer = require('buffer').Buffer;
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// API Keys from environment variables
const SPOONACULAR_KEY = process.env.SPOONACULAR_KEY;
const EDAMAM_NUTRITION_ID = process.env.EDAMAM_NUTRITION_ID;
const EDAMAM_NUTRITION_KEY = process.env.EDAMAM_NUTRITION_KEY;
const EDAMAM_FOOD_ID = process.env.EDAMAM_FOOD_ID;
const EDAMAM_FOOD_KEY = process.env.EDAMAM_FOOD_KEY;
const FATSECRET_CLIENT_ID = process.env.FATSECRET_CLIENT_ID;
const FATSECRET_CLIENT_SECRET = process.env.FATSECRET_CLIENT_SECRET;

// Helper: Convert base64 to buffer
function base64ToBuffer(base64String) {
  const base64Data = base64String.split(',')[1] || base64String;
  return Buffer.from(base64Data, 'base64');
}

// Step 1: Analyze image with Spoonacular
async function analyzeWithSpoonacular(imageBase64) {
  try {
    const buffer = base64ToBuffer(imageBase64);
    const formData = new FormData();
    formData.append('image', buffer, 'image.jpg');

    const response = await axios.post(
      `https://api.spoonacular.com/food/images/analyze?apiKey=${SPOONACULAR_KEY}`,
      formData,
      { headers: formData.getHeaders() }
    );

    if (response.data.category && response.data.category.name) {
      return response.data.category.name.replace(/_/g, ' ');
    }
    throw new Error('No food detected');
  } catch (error) {
    console.error('Spoonacular error:', error.message);
    throw error;
  }
}

// Tab 1: Get nutrition from Edamam Nutrition API
async function getNutritionEdamam1(foodName) {
  try {
    const response = await axios.get('https://api.edamam.com/api/nutrition-data', {
      params: {
        query: foodName,
        app_id: EDAMAM_NUTRITION_ID,
        app_key: EDAMAM_NUTRITION_KEY,
        nutrition_type: 'logging'
      }
    });

    if (response.data.foods && response.data.foods.length > 0) {
      const food = response.data.foods[0];
      return {
        calories: food.nutrients.ENERC_KCAL || 0,
        protein: food.nutrients.PROCNT || 0,
        carbs: food.nutrients.CHOCDF || 0,
        fat: food.nutrients.FAT || 0
      };
    }
    throw new Error('Food not found');
  } catch (error) {
    console.error('Edamam Nutrition error:', error.message);
    throw error;
  }
}

// Tab 2: Get nutrition from Edamam Food Database API
async function getNutritionEdamam2(foodName) {
  try {
    const response = await axios.get('https://api.edamam.com/api/food/database/v2/parser', {
      params: {
        query: foodName,
        app_id: EDAMAM_FOOD_ID,
        app_key: EDAMAM_FOOD_KEY,
        type: 'public'
      }
    });

    if (response.data.hints && response.data.hints.length > 0) {
      const food = response.data.hints[0].food;
      return {
        calories: food.nutrients.ENERC_KCAL || 0,
        protein: food.nutrients.PROCNT || 0,
        carbs: food.nutrients.CHOCDF || 0,
        fat: food.nutrients.FAT || 0
      };
    }
    throw new Error('Food not found');
  } catch (error) {
    console.error('Edamam Food DB error:', error.message);
    throw error;
  }
}

// Tab 3: Get nutrition from FatSecret API
async function getNutritionFatSecret(foodName) {
  try {
    // FatSecret uses OAuth 2.0
    const params = new URLSearchParams();
    params.append('client_id', FATSECRET_CLIENT_ID);
    params.append('client_secret', FATSECRET_CLIENT_SECRET);
    params.append('grant_type', 'client_credentials');
    params.append('scope', 'basic');

    const tokenResponse = await axios.post('https://oauth.fatsecret.com/connect/token', params);
    const accessToken = tokenResponse.data.access_token;

    const searchResponse = await axios.get('https://platform.fatsecret.com/rest/server.api', {
      params: {
        method: 'food.search',
        search_expression: foodName,
        format: 'json'
      },
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (searchResponse.data.foods && searchResponse.data.foods.food) {
      const foods = Array.isArray(searchResponse.data.foods.food)
        ? searchResponse.data.foods.food
        : [searchResponse.data.foods.food];
      
      if (foods.length > 0) {
        const foodId = foods[0].food_id;
        
        const detailResponse = await axios.get('https://platform.fatsecret.com/rest/server.api', {
          params: {
            method: 'food.get_v2',
            food_id: foodId,
            format: 'json'
          },
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        const food = detailResponse.data.food;
        const serving = food.servings.serving[0];
        
        return {
          calories: parseFloat(serving.calories) || 0,
          protein: parseFloat(serving.protein) || 0,
          carbs: parseFloat(serving.carbohydrate) || 0,
          fat: parseFloat(serving.fat) || 0
        };
      }
    }
    throw new Error('Food not found');
  } catch (error) {
    console.error('FatSecret error:', error.message);
    throw error;
  }
}

// Tab 4: Get nutrition from Spoonacular
async function getNutritionSpoonacular(foodName) {
  try {
    const response = await axios.get('https://api.spoonacular.com/food/ingredients/search', {
      params: {
        query: foodName,
        number: 1,
        apiKey: SPOONACULAR_KEY
      }
    });

    if (response.data && response.data.length > 0) {
      const ingredient = response.data[0];
      
      const nutritionResponse = await axios.get(
        `https://api.spoonacular.com/recipes/guessNutrition?title=${encodeURIComponent(foodName)}&apiKey=${SPOONACULAR_KEY}`
      );

      return {
        calories: nutritionResponse.data.calories || 0,
        protein: nutritionResponse.data.protein || 0,
        carbs: nutritionResponse.data.carbs || 0,
        fat: nutritionResponse.data.fat || 0
      };
    }
    throw new Error('Food not found');
  } catch (error) {
    console.error('Spoonacular nutrition error:', error.message);
    throw error;
  }
}

// Tab 5: Get nutrition from OpenFoodFacts
async function getNutritionOpenFoodFacts(foodName) {
  try {
    const response = await axios.get('https://world.openfoodfacts.org/cgi/search.pl', {
      params: {
        search_terms: foodName,
        search_simple: 1,
        action: 'process',
        json: 1,
        page_size: 1
      }
    });

    if (response.data.products && response.data.products.length > 0) {
      const product = response.data.products[0];
      return {
        calories: product.nutriments['energy-kcal'] || product.nutriments['energy_kcal'] || 0,
        protein: product.nutriments.proteins || 0,
        carbs: product.nutriments.carbohydrates || 0,
        fat: product.nutriments.fat || 0
      };
    }
    throw new Error('Food not found');
  } catch (error) {
    console.error('OpenFoodFacts error:', error.message);
    throw error;
  }
}

// Main API endpoint
app.post('/api/analyze-image', async (req, res) => {
  try {
    const { image, tab } = req.body;

    if (!image || !tab) {
      return res.status(400).json({ error: 'Missing image or tab' });
    }

    // Step 1: Get food name from image using Spoonacular
    const foodName = await analyzeWithSpoonacular(image);

    // Step 2: Get nutrition based on selected tab
    let nutrition;
    switch (tab) {
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
        nutrition = await getNutritionSpoonacular(foodName);
        break;
      case 5:
        nutrition = await getNutritionOpenFoodFacts(foodName);
        break;
      default:
        throw new Error('Invalid tab');
    }

    res.json({
      foodName: foodName.charAt(0).toUpperCase() + foodName.slice(1),
      nutrition: nutrition
    });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to analyze image' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
