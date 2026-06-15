// orchestrator/src/bootstrap.ts
//
// MUST be the first import of the process. Loads .env, resolves
// data/settings.json (precedence json > env > default), and writes the resolved
// values back into process.env so every downstream consumer — the winston
// logger (@yui/shared, reads process.env.LOG_LEVEL at load), presence,
// conversations, TTS, env.ts — reads a single source of truth with no per-call
// wiring. See docs/superpowers/specs/2026-06-15-app-editable-config-design.md.
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import { initSettings, getSettings, applyToEnv } from './settings';

initSettings();
applyToEnv(getSettings());

export {};
