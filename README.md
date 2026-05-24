# CodeAtlas

AI-powered code exploration and editing IDE — visualize architecture, edit code, run commands, all through natural language.

## Features

- **AI Chat Agent** — Edit code, run shell commands, read files through conversation with evidence-based LLM
- **Project Overview** — Autonomous agent explores your codebase and generates detailed architectural overviews with issue detection
- **Feature Tree** — Hierarchical navigation: Overview → Feature Groups → Features → Flow Steps
- **Code Viewer** — Syntax highlighting, line numbers, clickable function navigation
- **Shell Command Approval** — Modal confirmation before executing commands, 15s timeout auto-background
- **Background Tasks** — Status bar tracks all running analyses and shell commands
- **Resizable Panels** — Drag-to-resize file explorer, code viewer, feature panel, and chat
- **Frameless Window** — Custom title bar with VSCode-style window controls
- **Python Backend** — FastAPI + SQLite persistence

## Architecture

```
┌──────────┬───────────────────┬──────────────┐
│ Explorer │    Code Viewer    │  Agent Chat  │
│   File   │   (highlighting)  │  (streaming) │
│   Tree   │                   │              │
├──────────┴───────────────────┤              │
│    Feature Tree + Detail     │              │
└──────────────────────────────┴──────────────┘
```

## Tech Stack

- **Frontend**: Electron, React 19, TypeScript, Zustand, Tailwind CSS, Vite
- **Backend**: FastAPI, SQLite, OpenAI SDK (DeepSeek-compatible)
- **Build**: Vite, vite-plugin-electron, electron-builder

## Quick Start

```bash
# Install dependencies
cd frontend && npm install
cd backend && pip install -r requirements.txt

# Run
.\start.bat
```

Or manually:

```bash
# Terminal 1 — Backend
cd backend
python -m uvicorn main:app --port 19850 --reload

# Terminal 2 — Electron
cd frontend
npm run electron:dev
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEATLAS_LLM_API_KEY` | THKEY_... | LLM API key |
| `CODEATLAS_LLM_BASE_URL` | https://aiproxy2.abujlb.com/deepseek/v1 | LLM API endpoint |
| `CODEATLAS_LLM_MODEL` | deepseek-v4-pro | LLM model name |

## Project Data

All analysis data is stored in `.codeatlas/` inside your project directory:

- `.codeatlas/codeatlas.db` — SQLite database (feature graph, change queue)
- `.codeatlas/features.json` — Legacy JSON storage (migrated to SQLite)

## Development

```bash
# Backend hot-reload
cd backend && python -m uvicorn main:app --port 19850 --reload

# Frontend dev (React only, no Electron)
cd frontend && npm run dev

# Frontend + Electron
cd frontend && npm run electron:dev

# Build
cd frontend && npm run build

# Package
cd frontend && npm run dist
```

## License

MIT
