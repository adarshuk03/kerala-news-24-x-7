require("dotenv").config();
const OpenAI = require("openai");

console.log('api key123',process.env.GROQ_API_KEY);


const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

module.exports = openai;