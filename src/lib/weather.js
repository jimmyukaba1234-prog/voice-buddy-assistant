const WEATHER_KEYWORDS =
  /\b(weather|temperature|forecast|rain|raining|sunny|cloudy|hot|cold|windy)\b/i;
const HERE_PATTERN = /\b(here|my location|near me|where i am)\b/i;

const WEATHER_CODES = new Map([
  [0, "clear"],
  [1, "mostly clear"],
  [2, "partly cloudy"],
  [3, "cloudy"],
  [45, "foggy"],
  [48, "foggy"],
  [51, "light drizzle"],
  [53, "drizzle"],
  [55, "heavy drizzle"],
  [56, "freezing drizzle"],
  [57, "freezing drizzle"],
  [61, "light rain"],
  [63, "rain"],
  [65, "heavy rain"],
  [66, "freezing rain"],
  [67, "freezing rain"],
  [71, "light snow"],
  [73, "snow"],
  [75, "heavy snow"],
  [77, "snow grains"],
  [80, "light rain showers"],
  [81, "rain showers"],
  [82, "heavy rain showers"],
  [85, "snow showers"],
  [86, "heavy snow showers"],
  [95, "thunderstorms"],
  [96, "thunderstorms with hail"],
  [99, "thunderstorms with hail"],
]);

function cleanLocation(value) {
  return (value || "")
    .replace(/[?.!,]+$/g, "")
    .replace(/\b(today|now|right now|this morning|this afternoon|tonight)\b/gi, "")
    .trim();
}

export function isWeatherPrompt(message) {
  return WEATHER_KEYWORDS.test(message || "");
}

export function extractWeatherLocation(message) {
  const text = message || "";

  if (!isWeatherPrompt(text)) {
    return { handled: false, location: "" };
  }

  if (HERE_PATTERN.test(text)) {
    return { handled: true, location: "", needsKnownLocation: true };
  }

  const explicitLocation =
    text.match(/\b(?:in|for|at|around)\s+([a-z][a-z\s,'.-]{1,80}?)(?:\s+today|\s+now|\s+right now|[?.!]|$)/i)?.[1] ||
    text.match(/\bweather\s+([a-z][a-z\s,'.-]{1,80}?)(?:\s+today|\s+now|\s+right now|[?.!]|$)/i)?.[1];

  return {
    handled: true,
    location: cleanLocation(explicitLocation),
    needsKnownLocation: false,
  };
}

export function findKnownWeatherLocation(memories = []) {
  const locationMemory = memories.find((memory) => {
    const haystack = `${memory.key || ""} ${memory.value || ""} ${
      memory.metadata?.subject || ""
    }`.toLowerCase();

    return /\b(location|city|town|state|country|home|live|lives|based)\b/.test(
      haystack
    );
  });

  if (!locationMemory) {
    return "";
  }

  const value = locationMemory.value || "";
  const match =
    value.match(/\b(?:in|at|near|is)\s+([A-Z][a-zA-Z\s,'.-]{1,60})(?:[.?!]|$)/) ||
    value.match(/,\s*([A-Z][a-zA-Z\s,'.-]{1,60})(?:[.?!]|$)/);

  return cleanLocation(match?.[1] || "");
}

async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Weather request failed (${response.status})`);
  }

  return response.json();
}

async function geocodeLocation(location) {
  const url =
    "https://geocoding-api.open-meteo.com/v1/search" +
    `?name=${encodeURIComponent(location)}` +
    "&count=1&language=en&format=json";
  const data = await fetchJson(url);
  const place = data.results?.[0];

  if (!place) {
    return null;
  }

  return {
    name: place.name,
    admin1: place.admin1,
    country: place.country,
    latitude: place.latitude,
    longitude: place.longitude,
  };
}

async function fetchForecast(place) {
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${place.latitude}` +
    `&longitude=${place.longitude}` +
    "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum" +
    "&forecast_days=1&timezone=auto";

  return fetchJson(url);
}

function placeName(place) {
  return [place.name, place.admin1, place.country]
    .filter(Boolean)
    .filter(
      (part, index, all) =>
        all.findIndex((other) => other.toLowerCase() === part.toLowerCase()) ===
        index
    )
    .join(", ");
}

function weatherDescription(code) {
  return WEATHER_CODES.get(code) || "mixed conditions";
}

function buildWeatherReply(message, place, forecast) {
  const current = forecast.current || {};
  const daily = forecast.daily || {};
  const temp = Math.round(current.temperature_2m);
  const feelsLike = Math.round(current.apparent_temperature);
  const high = Math.round(daily.temperature_2m_max?.[0]);
  const low = Math.round(daily.temperature_2m_min?.[0]);
  const rainChance = daily.precipitation_probability_max?.[0] ?? 0;
  const rainAmount = daily.precipitation_sum?.[0] ?? 0;
  const condition = weatherDescription(current.weather_code);
  const dailyCondition = weatherDescription(daily.weather_code?.[0]);
  const locationName = placeName(place);
  const asksRain = /\brain|raining|umbrella\b/i.test(message);

  if (asksRain) {
    const rainAnswer =
      rainChance >= 50 || rainAmount > 0.5
        ? `Yes, rain is likely in ${locationName} today.`
        : `Rain does not look likely in ${locationName} today.`;

    return `${rainAnswer} The chance of rain is ${rainChance}%, with about ${rainAmount} mm expected. It is currently ${temp} C and ${condition}.`;
  }

  return `In ${locationName}, it is ${temp} C and ${condition}, feeling like ${feelsLike} C. Today should be ${dailyCondition}, with a high of ${high} C, a low of ${low} C, and a ${rainChance}% chance of rain.`;
}

export async function getWeatherReply(message, location) {
  const clean = cleanLocation(location);

  if (!clean) {
    return "What city or area should I check the weather for?";
  }

  const place = await geocodeLocation(clean);

  if (!place) {
    return `I could not find weather for ${clean}. Try a nearby city or include the country.`;
  }

  const forecast = await fetchForecast(place);
  return buildWeatherReply(message, place, forecast);
}
