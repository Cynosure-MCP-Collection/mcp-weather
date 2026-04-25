#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import process from 'node:process';
import { z } from 'zod';

// ── Polyfill check ─────────────────────────────────────────────────────────────

if (typeof fetch === 'undefined') {
    throw new Error(
        'Global fetch is not available. Upgrade to Node ≥ 18, or add "node-fetch" as a dependency ' +
        'and import it: import fetch from "node-fetch"; (then remove this check).',
    );
}

// ── Open-Meteo API helpers ─────────────────────────────────────────────────────

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = 10_000; // 10 s per request
const MAX_RETRIES = 3;
const RETRY_DELAY = 500; // ms, doubled each attempt

interface GeoResult {
    name: string;
    latitude: number;
    longitude: number;
    country: string;
    country_code: string;
    admin1?: string;
    timezone: string;
    population?: number;
}

interface ResolvedCoords {
    lat: number;
    lon: number;
    label: string;
    timezone: string;
}

// ── Resilient fetch with timeout + retry ──────────────────────────────────────

async function fetchJSON<T>(url: string, attempt = 1): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const shortUrl = url.length > 120 ? url.slice(0, 120) + '…' : url;

    log(`fetch attempt ${attempt}/${MAX_RETRIES}: ${shortUrl}`);

    try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);

        // Retry on 429 / 5xx
        if (res.status === 429 || res.status >= 500) {
            log(`  → ${res.status}, will retry`);
            if (attempt < MAX_RETRIES) {
                await sleep(RETRY_DELAY * attempt);
                return fetchJSON<T>(url, attempt + 1);
            }
            throw new Error(`API returned ${res.status} after ${MAX_RETRIES} attempts.`);
        }

        if (!res.ok) {
            const body = await res.text();
            throw new Error(`API error ${res.status}: ${body.slice(0, 200)}`);
        }

        log(`  → ${res.status} OK`);
        return res.json() as Promise<T>;
    } catch (err) {
        clearTimeout(timer);
        const isTimeout = err instanceof Error && err.name === 'AbortError';
        const isNetworkError = err instanceof TypeError; // fetch() itself threw

        log(`  → error (attempt ${attempt}): ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);

        if ((isTimeout || isNetworkError) && attempt < MAX_RETRIES) {
            await sleep(RETRY_DELAY * attempt);
            return fetchJSON<T>(url, attempt + 1);
        }
        throw isTimeout ? new Error(`Request timed out after ${TIMEOUT_MS / 1000}s`) : err;
    }
}

/** Write a timestamped debug line to stderr (never stdout — that's the MCP wire). */
function log(msg: string): void {
    process.stderr.write(`[weather-mcp ${new Date().toISOString()}] ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Geocoding ──────────────────────────────────────────────────────────────────

async function geocode(query: string): Promise<GeoResult[]> {
    const url = `${GEOCODING_URL}?name=${encodeURIComponent(query)}&count=5&language=en&format=json`;
    const data = await fetchJSON<{ results?: GeoResult[] }>(url);
    return data.results ?? [];
}

async function resolveCoords(
    location?: string,
    latitude?: number,
    longitude?: number,
    countryHint?: string,
): Promise<ResolvedCoords> {
    if (latitude !== undefined && longitude !== undefined) {
        return { lat: latitude, lon: longitude, label: `${latitude}, ${longitude}`, timezone: 'auto' };
    }
    if (!location) {
        throw new Error('Provide either a location name or latitude/longitude coordinates.');
    }

    const results = await geocode(location);
    if (results.length === 0) {
        throw new Error(`Could not find location "${location}". Try a more specific name or use coordinates.`);
    }

    log(`geocode "${location}": ${results.length} result(s): ${results.map(r => `${r.name}, ${r.country_code} (pop:${r.population ?? '?'})`).join(' | ')}`);

    // 1. If a country hint is given, prefer a matching result
    // 2. Otherwise pick the result with the highest population (avoids Vienna,VA beating Vienna,AT)
    // 3. Fall back to the API rank order
    let r: GeoResult;
    if (countryHint) {
        const match = results.find(x => x.country_code?.toUpperCase() === countryHint.toUpperCase());
        r = match ?? results[0];
        if (!match) log(`  country hint "${countryHint}" had no match, falling back to top result`);
    } else {
        const withPop = results.filter(x => x.population !== undefined && x.population > 0);
        r = withPop.length > 0
            ? withPop.reduce((best, x) => (x.population! > best.population! ? x : best))
            : results[0];
    }

    const region = r.admin1 ? `, ${r.admin1}` : '';
    log(`  resolved to: ${r.name}${region}, ${r.country} (${r.latitude}, ${r.longitude})`);
    return {
        lat: r.latitude,
        lon: r.longitude,
        label: `${r.name}${region}, ${r.country}`,
        timezone: r.timezone ?? 'auto',
    };
}

// ── Lookup tables ──────────────────────────────────────────────────────────────

function weatherCodeToDescription(code: number): string {
    const map: Record<number, string> = {
        0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
        45: 'Fog', 48: 'Rime fog',
        51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
        56: 'Light freezing drizzle', 57: 'Dense freezing drizzle',
        61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
        66: 'Light freezing rain', 67: 'Heavy freezing rain',
        71: 'Slight snowfall', 73: 'Moderate snowfall', 75: 'Heavy snowfall', 77: 'Snow grains',
        80: 'Slight showers', 81: 'Moderate showers', 82: 'Violent showers',
        85: 'Slight snow showers', 86: 'Heavy snow showers',
        95: 'Thunderstorm', 96: 'Thunderstorm + slight hail', 99: 'Thunderstorm + heavy hail',
    };
    return map[code] ?? `Unknown (WMO code ${code})`;
}

function degreesToCardinal(deg: number): string {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(deg / 45) % 8];
}

// ── Shared input schema ────────────────────────────────────────────────────────

const locationSchema = {
    location: z.string().optional().describe(
        'City or place name (e.g. "Vienna", "Berlin"). Used for geocoding when coordinates are not provided.',
    ),
    latitude: z.number().min(-90).max(90).optional().describe('Latitude (decimal degrees)'),
    longitude: z.number().min(-180).max(180).optional().describe('Longitude (decimal degrees)'),
    country_code: z.string().length(2).optional().describe(
        'ISO 3166-1 alpha-2 country code (e.g. "AT", "DE") to disambiguate city names during geocoding.',
    ),
    units: z.enum(['metric', 'imperial']).default('metric').describe(
        'Unit system: metric (°C, km/h) or imperial (°F, mph)',
    ),
};

// ── MCP Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'Weather Fetcher',
    version: '2.0.0',
    title: 'Weather Fetcher',
    description: 'Fetch current weather and forecasts using the free Open-Meteo API.',
    icons: [{ src: 'https://raw.githubusercontent.com/andreasjhagen/Cynosure-MCPs/main/mcp-weather/icon.png', mimeType: 'image/png' }],
});

// ── Tool: get_current_weather ──────────────────────────────────────────────────

server.registerTool(
    'get_current_weather',
    {
        description: 'Get current weather conditions for a location. Provide a place name or lat/lon. ' +
            'Supply country_code (e.g. "AT") to avoid geocoding the wrong city.',
        inputSchema: locationSchema,
    },
    async ({ location, latitude, longitude, country_code, units }) => {
        try {
            const coords = await resolveCoords(location, latitude, longitude, country_code);
            const isImperial = units === 'imperial';

            const params = new URLSearchParams({
                latitude: String(coords.lat),
                longitude: String(coords.lon),
                current: [
                    'temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
                    'precipitation', 'weather_code', 'cloud_cover',
                    'pressure_msl', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
                ].join(','),
                temperature_unit: isImperial ? 'fahrenheit' : 'celsius',
                wind_speed_unit: isImperial ? 'mph' : 'kmh',
                timezone: coords.timezone,
            });

            const data = await fetchJSON<{
                current: Record<string, number>;
                current_units: Record<string, string>;
            }>(`${WEATHER_URL}?${params}`);

            const c = data.current;
            const u = data.current_units;

            const lines = [
                `Location:    ${coords.label}`,
                `Conditions:  ${weatherCodeToDescription(c.weather_code)}`,
                `Temperature: ${c.temperature_2m}${u.temperature_2m} (feels like ${c.apparent_temperature}${u.apparent_temperature})`,
                `Humidity:    ${c.relative_humidity_2m}${u.relative_humidity_2m}`,
                `Cloud cover: ${c.cloud_cover}${u.cloud_cover}`,
                `Wind:        ${c.wind_speed_10m} ${u.wind_speed_10m}, gusts ${c.wind_gusts_10m} ${u.wind_gusts_10m}, from ${degreesToCardinal(c.wind_direction_10m)} (${c.wind_direction_10m}°)`,
                `Precip:      ${c.precipitation}${u.precipitation}`,
                `Pressure:    ${c.pressure_msl}${u.pressure_msl}`,
            ];

            return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }
    },
);

// ── Tool: get_weather_forecast ─────────────────────────────────────────────────

server.registerTool(
    'get_weather_forecast',
    {
        description: 'Get a daily weather forecast (up to 16 days) for a location. ' +
            'Returns high/low temperatures, precipitation probability, wind, UV index, and sunrise/sunset times.',
        inputSchema: {
            ...locationSchema,
            days: z.number().min(1).max(16).default(7).describe('Number of forecast days (1–16)'),
        },
    },
    async ({ location, latitude, longitude, country_code, units, days }) => {
        try {
            const coords = await resolveCoords(location, latitude, longitude, country_code);
            const isImperial = units === 'imperial';

            const params = new URLSearchParams({
                latitude: String(coords.lat),
                longitude: String(coords.lon),
                daily: [
                    'weather_code',
                    'temperature_2m_max', 'temperature_2m_min',
                    'apparent_temperature_max', 'apparent_temperature_min',
                    'precipitation_sum', 'precipitation_probability_max', 'precipitation_hours',
                    'snowfall_sum',
                    'wind_speed_10m_max', 'wind_gusts_10m_max', 'wind_direction_10m_dominant',
                    'uv_index_max', 'sunrise', 'sunset',
                ].join(','),
                temperature_unit: isImperial ? 'fahrenheit' : 'celsius',
                wind_speed_unit: isImperial ? 'mph' : 'kmh',
                timezone: coords.timezone,
                forecast_days: String(days),
            });

            const data = await fetchJSON<{
                daily: Record<string, (number | string)[]>;
                daily_units: Record<string, string>;
            }>(`${WEATHER_URL}?${params}`);

            const d = data.daily;
            const du = data.daily_units;
            const lines: string[] = [`${days}-day forecast for ${coords.label}\n`];

            for (let i = 0; i < (d.time as string[]).length; i++) {
                const dominantDir = degreesToCardinal(d.wind_direction_10m_dominant[i] as number);
                lines.push(`${d.time[i]}`);
                lines.push(`  ${weatherCodeToDescription(d.weather_code[i] as number)}`);
                lines.push(`  Temp:    ${d.temperature_2m_min[i]}${du.temperature_2m_min} → ${d.temperature_2m_max[i]}${du.temperature_2m_max} (feels ${d.apparent_temperature_min[i]}${du.apparent_temperature_min} → ${d.apparent_temperature_max[i]}${du.apparent_temperature_max})`);
                lines.push(`  Precip:  ${d.precipitation_sum[i]}${du.precipitation_sum}, ${d.precipitation_probability_max[i]}${du.precipitation_probability_max} chance, ${d.precipitation_hours[i]}h`);
                if ((d.snowfall_sum[i] as number) > 0) {
                    lines.push(`  Snow:    ${d.snowfall_sum[i]}${du.snowfall_sum}`);
                }
                lines.push(`  Wind:    up to ${d.wind_speed_10m_max[i]} ${du.wind_speed_10m_max}, gusts ${d.wind_gusts_10m_max[i]} ${du.wind_gusts_10m_max}, from ${dominantDir}`);
                lines.push(`  UV:      ${d.uv_index_max[i]}`);
                lines.push(`  Sun:     ↑${d.sunrise[i]?.toString().slice(-5)} ↓${d.sunset[i]?.toString().slice(-5)}`);
                lines.push('');
            }

            return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }
    },
);

// ── Tool: get_hourly_forecast ──────────────────────────────────────────────────

server.registerTool(
    'get_hourly_forecast',
    {
        description: 'Get a detailed hour-by-hour forecast for today (in the location\'s local timezone). ' +
            'Returns temperature, feels-like, precipitation, wind, humidity, visibility, and cloud cover.',
        inputSchema: locationSchema,
    },
    async ({ location, latitude, longitude, country_code, units }) => {
        try {
            const coords = await resolveCoords(location, latitude, longitude, country_code);
            const isImperial = units === 'imperial';

            // Use forecast_days=1 — Open-Meteo returns data in the location's own timezone
            // when timezone is passed, so "today" is always correct for the target locale.
            const params = new URLSearchParams({
                latitude: String(coords.lat),
                longitude: String(coords.lon),
                hourly: [
                    'temperature_2m', 'apparent_temperature',
                    'relative_humidity_2m', 'dew_point_2m',
                    'precipitation_probability', 'precipitation', 'rain', 'snowfall',
                    'weather_code', 'cloud_cover', 'visibility',
                    'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
                    'uv_index', 'is_day',
                ].join(','),
                temperature_unit: isImperial ? 'fahrenheit' : 'celsius',
                wind_speed_unit: isImperial ? 'mph' : 'kmh',
                visibility_unit: isImperial ? 'ft' : 'km',
                timezone: coords.timezone,
                forecast_days: '1',
            });

            const data = await fetchJSON<{
                hourly: Record<string, (number | string)[]>;
                hourly_units: Record<string, string>;
            }>(`${WEATHER_URL}?${params}`);

            const h = data.hourly;
            const hu = data.hourly_units;
            const times = h.time as string[];

            if (times.length === 0) {
                throw new Error('No hourly data returned by the API.');
            }

            // The date comes from the API's own response — not the server clock — so
            // it's always the correct local date for the requested location.
            const targetDate = times[0].slice(0, 10);
            const lines: string[] = [`Hourly forecast for ${coords.label} on ${targetDate}\n`];

            for (let i = 0; i < times.length; i++) {
                const hour = times[i].slice(11, 16);
                const isDaytime = (h.is_day[i] as number) === 1;
                const icon = isDaytime ? '☀' : '☾';

                const windDir = degreesToCardinal(h.wind_direction_10m[i] as number);
                const wind = `${h.wind_speed_10m[i]} ${hu.wind_speed_10m} ${windDir}, gusts ${h.wind_gusts_10m[i]} ${hu.wind_gusts_10m}`;

                const precipProb = h.precipitation_probability[i] as number;
                const precipAmt = h.precipitation[i] as number;
                const precip = (precipProb > 0 || precipAmt > 0)
                    ? `${precipProb}% chance, ${precipAmt}${hu.precipitation}`
                    : 'none';

                const vis = h.visibility[i] as number;
                const visStr = isImperial
                    ? vis >= 5280 ? `${(vis / 5280).toFixed(1)} mi` : `${vis} ft`
                    : vis >= 1 ? `${vis.toFixed(1)} km` : `${(vis * 1000).toFixed(0)} m`;

                lines.push(`${hour} ${icon}  ${weatherCodeToDescription(h.weather_code[i] as number)}`);
                lines.push(`  Temp:       ${h.temperature_2m[i]}${hu.temperature_2m} (feels ${h.apparent_temperature[i]}${hu.apparent_temperature})`);
                lines.push(`  Humidity:   ${h.relative_humidity_2m[i]}${hu.relative_humidity_2m}, dew point ${h.dew_point_2m[i]}${hu.dew_point_2m}`);
                lines.push(`  Precip:     ${precip}`);
                if ((h.snowfall[i] as number) > 0) {
                    lines.push(`  Snow:       ${h.snowfall[i]}${hu.snowfall}`);
                }
                lines.push(`  Wind:       ${wind}`);
                lines.push(`  Cloud:      ${h.cloud_cover[i]}${hu.cloud_cover}`);
                lines.push(`  Visibility: ${visStr}`);
                lines.push(`  UV index:   ${h.uv_index[i]}`);
                lines.push('');
            }

            return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }
    },
);

// ── Start server ───────────────────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
