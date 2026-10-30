# AGENTS.md — LinguaNote AI

## 1. Project Overview

LinguaNote AI is a desktop-first, multilingual AI transcription assistant designed to capture speech, transcribe conversations in real time, process audio and video files, and convert speech into text that can be inserted into other applications.

The application must support conversations in which speakers switch naturally between French, Wolof, and English, including code-switching within a single sentence.

The primary interface is a floating desktop bubble that remains accessible while the user works in other applications.

### Core Objectives

1. Provide real-time speech transcription.
2. Transcribe imported audio and video files.
3. Support French, Wolof, and English, including mixed-language conversations.
4. Provide a floating desktop interface with global keyboard shortcuts.
5. Support voice dictation and text insertion into external applications.
6. Maintain a searchable transcription history.
7. Offer optional meeting summaries, decisions, and action items.
8. Prioritize local processing, privacy, and offline capabilities.
9. Maintain a modular architecture that allows speech recognition engines to be replaced without rewriting the application.

### Development Principles

- Reliability before feature quantity.
- Measurable transcription quality before advanced AI features.
- Local-first processing whenever practical.
- Modular, maintainable, and testable code.
- Explicit handling of errors, permissions, and resource limitations.
- Incremental implementation with validation after each milestone.
- No fabricated functionality, unsupported claims, or unnecessary dependencies.

---

## 2. Technology Stack

Use the following stack unless an existing repository decision or a documented technical limitation justifies a change.

### Desktop Application

- Electron
- React
- TypeScript
- Vite
- Tailwind CSS, if appropriate for the existing UI

Responsibilities:

- Floating overlay window.
- Main application window.
- Global keyboard shortcuts.
- Audio capture coordination.
- Communication with the transcription backend.
- Transcription display and user controls.
- Clipboard integration and text insertion.
- Desktop packaging and installation.

### Backend

- Python
- FastAPI
- Pydantic
- WebSockets for real-time communication
- SQLite for local persistence

Responsibilities:

- Transcription session management.
- Audio processing orchestration.
- Speech recognition.
- Language and segment metadata management.
- Transcription persistence.
- File processing.
- Export and integration services.

### Speech Processing

Evaluate the following technologies according to measured performance and compatibility:

- faster-whisper for multilingual speech recognition.
- FFmpeg for audio extraction and conversion.
- Silero VAD or an equivalent voice activity detection solution.
- Additional language detection, diarization, or streaming components when justified.

Do not assume that a model supports Wolof adequately merely because it supports multiple languages.

Verify model licenses, language coverage, hardware requirements, and distribution restrictions before integrating or redistributing models.

### Development and Packaging

- Git for version control.
- Python virtual environments managed with Poetry or another explicitly selected tool.
- npm for JavaScript dependencies, unless the repository adopts another package manager.
- Pytest for Python testing.
- Vitest and React Testing Library for frontend testing where appropriate.
- Playwright for end-to-end tests when useful.
- Electron Builder for desktop packaging.
- Docker for optional development services, not as a mandatory runtime dependency for end users.

Do not introduce multiple competing package managers or dependency management systems without a clear reason.

---

## 3. Repository Structure

Use the following structure as the intended architecture.

Adapt it to the actual repository state rather than creating every directory immediately.

```text
linguanote-ai/
├── AGENTS.md
├── README.md
├── .gitignore
├── .editorconfig
├── package.json
├── package-lock.json
├── apps/
│   └── desktop/
│       ├── electron/
│       │   ├── main.ts
│       │   ├── preload.ts
│       │   └── windows/
│       ├── src/
│       │   ├── components/
│       │   ├── features/
│       │   ├── hooks/
│       │   ├── services/
│       │   ├── types/
│       │   ├── App.tsx
│       │   └── main.tsx
│       ├── tests/
│       └── package.json
├── services/
│   └── transcription/
│       ├── app/
│       │   ├── main.py
│       │   ├── api/
│       │   ├── audio/
│       │   ├── engines/
│       │   ├── language/
│       │   ├── sessions/
│       │   ├── storage/
│       │   ├── export/
│       │   └── schemas/
│       ├── tests/
│       └── pyproject.toml
├── docs/
│   ├── architecture.md
│   ├── roadmap.md
│   ├── api-contracts.md
│   ├── security.md
│   └── evaluation-protocol.md
├── scripts/
├── assets/
└── data/
```

### Structure Rules

- Keep desktop UI code separate from backend processing.
- Keep audio processing separate from speech recognition.
- Keep speech recognition engines behind a common interface.
- Keep language handling separate from UI components.
- Keep database access behind dedicated storage modules.
- Avoid duplicate implementations of the same functionality.
- Do not store generated audio, model weights, databases, or large datasets in Git.
- Create directories only when needed by an implemented feature.
- Update this guide when the actual architecture changes significantly.

---

## 4. Architecture Rules

### 4.1 Desktop and Backend Separation

Electron is responsible for desktop integration and the user interface.

Python is responsible for speech processing, transcription orchestration, and backend services.

Do not place model inference, large audio-processing operations, or database business logic inside React components or the Electron main process.

Use explicit interfaces between the desktop application and the backend.

### 4.2 Communication

Use HTTP for conventional request-response operations.

Use WebSockets for live transcription events and other communication requiring low-latency updates.

Define and document request schemas, response schemas, and event types.

Handle:

- Connection failures.
- Reconnection.
- Invalid messages.
- Session termination.
- Duplicate events.
- Processing errors.
- Partial and final transcription updates.

Do not allow a failed WebSocket connection to silently corrupt or duplicate transcription content.

### 4.3 Transcription Engine Abstraction

Implement a common transcription interface so multiple recognition engines can be integrated without coupling them to the UI.

The abstraction should support the operations required by the selected engines, such as:

- File transcription.
- Streaming session initialization.
- Audio chunk processing.
- Session termination.
- Engine capability reporting.

Do not assume every engine supports true streaming, every language, or the same metadata.

Expose capabilities explicitly and implement fallbacks where appropriate.

### 4.4 Audio Processing

Keep audio capture, audio conversion, segmentation, voice activity detection, and speech recognition as separate responsibilities.

Preserve timestamps and maintain a consistent audio format between processing stages.

When processing overlapping audio windows, implement a deliberate strategy to prevent duplicated words and missing segments.

Distinguish provisional transcription text from finalized text.

Do not append revised partial results as new text without reconciling them with previous results.

### 4.5 Multilingual Processing

French, Wolof, and English are core product requirements.

The system must be designed for language switching within a session, including mixed-language utterances.

Never hardcode a single language for an entire session unless the user explicitly selects a language-restricted mode.

Language detection is an estimate, not proof of transcription correctness.

Do not automatically translate the original transcription.

Preserve the original recognized text and make translation an optional, separate operation.

Do not silently replace uncertain Wolof words with French or English words.

Any language-specific correction must be conservative, traceable, and reversible where practical.

### 4.6 Floating Desktop Interface

The floating bubble is a primary product feature.

Design it as a separate Electron window with explicit lifecycle and state management.

Support:

- Visible inactive state.
- Active recording state.
- Processing state.
- Error state.
- Expand and collapse actions.
- Start, pause, resume, and stop controls where supported.
- Global keyboard shortcuts.
- A clear recording indicator.

Keep the bubble responsive and independent of long-running transcription operations.

Do not implement invisible or deceptive recording behavior.

### 4.7 Audio Capture

Treat microphone capture, system audio capture, and imported media as separate sources.

Do not assume identical capture capabilities across Windows, Linux, and macOS.

Implement and test the initial target platform before adding cross-platform abstractions that cannot be validated.

Request permissions where required and provide clear feedback when capture is unavailable.

The application must never silently switch audio sources without informing the user.

### 4.8 Text Insertion

Keep clipboard operations and external text insertion separate from transcription generation.

Before inserting text, handle focus changes and potential destination errors.

Never overwrite unrelated clipboard content without a deliberate and documented strategy.

Do not assume that every external application supports programmatic text insertion.

---

## 5. Security and Privacy

Privacy is a core product requirement.

- Keep processing local by default when the selected model supports it.
- Never send audio or transcription content to external APIs without explicit configuration and user consent.
- Do not introduce telemetry that captures conversation content.
- Never commit API keys, passwords, access tokens, or personal machine configuration.
- Store secrets in environment variables or an appropriate secure credential store.
- Provide sanitized example configuration files when needed.
- Ignore local databases, recordings, temporary files, model weights, and generated exports in Git.
- Validate uploaded files and enforce reasonable size and duration limits.
- Use safe temporary-file handling.
- Restrict Electron renderer privileges.
- Keep `nodeIntegration` disabled.
- Enable `contextIsolation`.
- Use a narrow, validated preload API.
- Validate all IPC messages.
- Restrict navigation and external URL handling.
- Protect local backend endpoints against unauthorized access and cross-origin requests.
- Do not expose the local backend unnecessarily to the network.
- Avoid logging sensitive audio or transcript contents.
- Provide explicit controls for recording, stopping, retention, and deletion.
- Document cloud processing, retention, and data deletion behavior.

Security settings must not be weakened merely to make a feature work.

When handling meeting recordings, consider consent requirements and applicable data-protection rules.

---

## 6. Coding Standards

### General

- Write clear, maintainable, production-oriented code.
- Prefer small modules with a single responsibility.
- Use descriptive names.
- Avoid unnecessary abstraction.
- Avoid duplicated business logic.
- Keep functions focused and reasonably small.
- Handle errors explicitly.
- Do not silently swallow exceptions.
- Avoid global mutable state unless justified.
- Add comments for non-obvious decisions, not for every line.
- Do not leave placeholder implementations presented as working features.
- Do not introduce unrelated refactoring into feature changes.

### TypeScript and React

- Enable strict TypeScript settings.
- Avoid `any`; use explicit types or `unknown` with appropriate validation.
- Prefer functional React components and hooks.
- Keep components focused on presentation and UI interactions.
- Move complex business logic into dedicated modules or hooks.
- Avoid unnecessary `useEffect` usage and duplicated state.
- Clean up event listeners, timers, streams, and subscriptions.
- Define explicit types for IPC and WebSocket events.
- Do not expose unrestricted Node.js APIs to the renderer.
- Validate data received from the backend.

### Python

- Use type hints for public functions and important interfaces.
- Use Pydantic models for API request and response validation.
- Use asynchronous functions only when the underlying operation benefits from asynchronous execution.
- Do not block FastAPI's event loop with expensive synchronous operations.
- Execute long-running inference in an appropriate worker or executor.
- Manage model lifecycles deliberately.
- Avoid loading multiple large model instances unnecessarily.
- Use structured logging.
- Handle temporary files and subprocesses safely.
- Avoid circular imports and oversized modules.
- Keep configuration separate from business logic.

### Naming Conventions

- Python modules and functions: `snake_case`.
- Python classes: `PascalCase`.
- React components: `PascalCase.tsx`.
- TypeScript variables and functions: `camelCase`.
- TypeScript types and interfaces: `PascalCase`.
- Environment variables: `UPPER_SNAKE_CASE`.
- Tests: `test_*.py` for Pytest and `*.test.ts` or `*.test.tsx` for frontend tests.

Follow existing conventions when they are consistent and intentional.

---

## 7. Testing Requirements

Every new feature must include appropriate tests.

### Python Tests

Test:

- API validation.
- Session lifecycle.
- Audio preprocessing.
- Transcription result normalization.
- Partial-to-final segment reconciliation.
- Error handling.
- Storage operations.
- Export functionality.
- WebSocket behavior.

Use mocks for external services and expensive model inference when appropriate.

Keep a small, deterministic test suite that does not require downloading large models.

### Frontend Tests

Test:

- Bubble state transitions.
- Start and stop actions.
- Loading and error states.
- Transcription rendering.
- Partial and final transcript reconciliation.
- IPC validation.
- WebSocket disconnection and recovery.
- Clipboard behavior where practical.

### Integration Tests

Validate the complete flow:

1. Start the backend.
2. Create a transcription session.
3. Submit audio or simulated audio chunks.
4. Receive transcription events.
5. Finalize the session.
6. Persist the result.
7. Retrieve and export the transcription.

### Multilingual Evaluation

Maintain an evaluation dataset with appropriate permissions and reference transcriptions.

Evaluate French, English, Wolof, and mixed-language recordings separately.

Track word error rate where meaningful, character error rate, latency, memory consumption, and common failure cases.

Do not claim that a model supports a language adequately without evidence.

Do not require real meeting recordings in automated tests. Use synthetic fixtures or authorized, anonymized test samples.

### Before Completing a Change

- Run the relevant tests.
- Run the applicable formatter and linter.
- Run TypeScript checks when frontend code changes.
- Run backend tests when Python code changes.
- Build the application when feasible.
- Report tests that were not run and explain why.
- Never claim a test passed unless it was actually executed successfully.

---

## 8. Development Workflow

Work incrementally.

Before implementing a significant change:

1. Inspect the existing repository.
2. Read this file and any relevant nested `AGENTS.md` files.
3. Identify existing architectural decisions.
4. Understand the affected modules.
5. Propose a concise implementation plan when the task is substantial.
6. Implement the smallest complete and testable change.
7. Run relevant tests and validation commands.
8. Summarize the changes, test results, and remaining limitations.

Do not regenerate the entire repository when asked to modify one feature.

Do not replace existing working implementations without understanding their purpose.

Do not install dependencies unnecessarily.

Do not invent files, functions, endpoints, environment variables, or test results.

When a requirement is ambiguous, choose the least destructive approach and explain the assumption. Ask for clarification if the ambiguity affects architecture, security, data loss, or a major product decision.

Do not introduce a major architecture change without explaining its benefits and trade-offs.

---

## 9. Build and Development Commands

Document the actual commands in the relevant `README.md` files as soon as the corresponding package manifests exist.

Expected command categories include:

### Desktop

- Install JavaScript dependencies.
- Start the development environment.
- Run frontend tests.
- Run type checks.
- Run linting.
- Build the desktop application.
- Package the application for the target operating system.

### Backend

- Create and activate the Python environment.
- Install backend dependencies.
- Start FastAPI.
- Run Pytest.
- Run the formatter and linter.
- Execute integration tests.

Do not invent commands that are unsupported by the current manifests.

Prefer reproducible installations and committed lockfiles.

Never modify dependency versions merely to suppress an error without checking compatibility.

---

## 10. Project Roadmap and Priorities

Follow this order unless the user explicitly changes the priorities.

### Phase 1 — Proof of Concept

- Inspect the development environment.
- Establish the initial repository structure.
- Implement audio-file transcription.
- Evaluate French, English, and Wolof.
- Test mixed-language conversations.
- Measure quality and processing speed.

### Phase 2 — Live Transcription

- Implement audio chunk processing.
- Establish the WebSocket event contract.
- Display provisional and finalized text.
- Prevent duplicated or missing segments.
- Implement session lifecycle management.

### Phase 3 — Desktop Bubble

- Implement the Electron shell.
- Add the floating bubble.
- Connect the UI to the backend.
- Add global shortcuts.
- Display recording and processing states.

### Phase 4 — System Audio

- Implement and validate microphone capture.
- Implement and validate system audio capture on the target operating system.
- Add source selection and error handling.
- Test real meeting and media playback scenarios.

### Phase 5 — Productivity Features

- Add SQLite persistence.
- Add transcription history.
- Add file import and export.
- Add voice dictation and text insertion.
- Add search and session management.

### Phase 6 — Advanced Intelligence

- Evaluate speaker diarization.
- Add meeting summaries and action items.
- Improve language-specific recognition.
- Evaluate model adaptation for Wolof if the data and evaluation results justify it.
- Add optional cloud providers only when needed.

Do not skip the evaluation phase merely to accelerate UI development.

Do not implement advanced meeting intelligence before the core transcription pipeline is reliable.

---

## 11. Definition of Done

A task is complete only when:

- The requested behavior is implemented.
- The implementation follows the existing architecture.
- Appropriate error handling is present.
- Relevant tests have been added or updated.
- Applicable checks have been executed.
- Documentation is updated when necessary.
- No secrets or generated artifacts have been accidentally committed.
- Limitations and unsupported scenarios are documented.
- The final response clearly describes what changed and what was validated.

A visually complete interface is not proof that the underlying feature works.

A successful API response is not proof that transcription quality is adequate.

A successful local test is not proof of cross-platform compatibility.

---

## 12. Instructions to Codex

Act as a senior software engineer and technical architect.

Prioritize correctness, maintainability, privacy, and measurable product quality.

For each task:

- Inspect before modifying.
- Respect the existing repository.
- Follow the project roadmap.
- Keep changes focused.
- Explain important architectural trade-offs.
- Avoid unnecessary dependencies.
- Add tests for meaningful behavior.
- Report actual validation results.
- Identify blockers explicitly.
- Never claim that a feature works when it has only been scaffolded or mocked.

When implementing a feature, deliver a complete vertical slice whenever practical: UI, backend integration, error handling, tests, and documentation.

When a task is too large for one change, divide it into small, independently verifiable milestones.

The user's primary product requirements are multilingual transcription, reliable live processing, a floating desktop interface, and privacy-conscious local operation.

All architectural decisions must support those requirements.