# CodeAtlas

AI-powered code exploration and editing IDE — visualize architecture, edit code, run commands, all through natural language.

## Features

- **AI Chat Agent** — Edit code, run shell commands, read files through conversation. Evidence-based: only makes claims backed by actual file content.
- **Project Overview Agent** — Autonomous agent explores your codebase, generates architectural overviews, and detects issues (missing imports, API mismatches, etc.)
- **Feature Tree** — Hierarchical navigation: Overview → Feature Groups → Features → Flow Steps. Click to drill down, click files to jump to code.
- **Code Viewer** — Syntax highlighting, line numbers, clickable function navigation, scroll-to-line.
- **Shell Approval** — Modal confirmation before executing commands. 15-second timeout auto-switches to background. Track via status bar.
- **Send to Agent** — One click to send feature context (files, functions, flow steps) from the analysis panel to the chat agent.
- **Background Tasks** — Status bar tracks all running analyses, shell commands, and summaries.
- **Resizable Panels** — Drag to resize file explorer, code viewer, agent chat, and feature panels.
- **Streaming Responses** — LLM replies stream token-by-token. Stop button to cancel mid-generation.
- **Custom Title Bar** — Frameless window with VSCode-style window controls.

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

- **Frontend**: Electron 35, React 19, TypeScript, Zustand, Tailwind CSS, Vite 6
- **Backend**: FastAPI, SQLite (WAL mode), OpenAI-compatible SDK
- **Build**: vite-plugin-electron, electron-builder

## Quick Start

### Prerequisites

- Node.js 24+
- Python 3.12+

### Setup

```bash
# Clone
git clone https://github.com/wangzhongren/CodeAtlas.git
cd CodeAtlas

# Install frontend deps (includes Electron)
cd frontend && npm install

# Install backend deps
cd ../backend && pip install -r requirements.txt

# Configure API key
cp .env.example .env
# Edit .env with your LLM API credentials
```

### Run

```bash
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

## Configuration

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `CODEATLAS_LLM_API_KEY` | Your LLM API key |
| `CODEATLAS_LLM_BASE_URL` | LLM API base URL (OpenAI-compatible) |
| `CODEATLAS_LLM_MODEL` | Model name (e.g. `gpt-4o`, `deepseek-v4-pro`) |

> `.env` is gitignored — never commit your real credentials.

## How It Works

1. **Open a project folder** — The file tree appears on the left
2. **Ask the Agent** (right panel) — Edit code, run commands, ask questions. The Agent reads files as evidence before making claims.
3. **Analyze features** (bottom-left) — Click the refresh icon to generate a feature tree: Overview → Groups → Features
4. **Drill down** — Click nodes to expand in the left tree. Select nodes to see details with flow steps, files, and functions.
5. **Deep Analyze** — Selecting overview/group nodes triggers the Overview Agent to generate architectural descriptions and detect issues.
6. **Send to Agent** — Click "Ask Agent" on any feature or flow step to send context to the chat for targeted edits.

## Project Data

All analysis data is stored in `.codeatlas/` inside your opened project directory:

| File | Purpose |
|------|---------|
| `.codeatlas/codeatlas.db` | SQLite database (feature graph, change queue) |

## Development

```bash
# Backend with hot-reload
cd backend && python -m uvicorn main:app --port 19850 --reload

# Frontend only (no Electron)
cd frontend && npm run dev

# Full Electron app (dev mode)
cd frontend && npm run electron:dev

# Production build
cd frontend && npm run build
```

## License

MIT
