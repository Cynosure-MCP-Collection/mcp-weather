# @cynosure-mcp/weather

MCP server for fetching current weather and forecasts using the free [Open-Meteo](https://open-meteo.com/) API. No API key required.

## Installation

```bash
npx @cynosure-mcp/weather
```

Or install globally:

```bash
npm install -g @cynosure-mcp/weather
weather
```

## Tools

| Tool                   | Description                                                      |
| ---------------------- | ---------------------------------------------------------------- |
| `get_current_weather`  | Get current weather conditions (by location name or coordinates) |
| `get_weather_forecast` | Get a multi-day weather forecast                                 |

## Configuration

No configuration required — uses the free Open-Meteo API.

## MCP Config

```json
{
  "mcpServers": {
    "weather": {
      "command": "npx",
      "args": ["@cynosure-mcp/weather"]
    }
  }
}
```

## License

MIT
