DROP TABLE IF EXISTS pitch_decks;
DROP TABLE IF EXISTS concepts;

CREATE TABLE concepts (
  id SERIAL PRIMARY KEY,
  concept_text TEXT NOT NULL,
  storylines JSONB NOT NULL,
  title TEXT,
  pinned BOOLEAN NOT NULL DEFAULT false,
  -- 'story' = normal Story & Screenplay Agent project. 'production' = a
  -- standalone Production Management project started by importing an
  -- already-written screenplay, with no story-agent data at all.
  project_type TEXT NOT NULL DEFAULT 'story',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pitch_decks (
  id SERIAL PRIMARY KEY,
  concept_id INTEGER REFERENCES concepts(id) ON DELETE CASCADE,
  content JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  feedback TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE character_sheets (
  id SERIAL PRIMARY KEY,
  pitch_deck_id INTEGER REFERENCES pitch_decks(id) ON DELETE CASCADE,
  content JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  feedback TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE three_act_structures (
  id SERIAL PRIMARY KEY,
  pitch_deck_id INTEGER REFERENCES pitch_decks(id) ON DELETE CASCADE,
  content JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  feedback TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bit_sheets (
  id SERIAL PRIMARY KEY,
  three_act_structure_id INTEGER REFERENCES three_act_structures(id) ON DELETE CASCADE,
  content JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  feedback TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scene_lists (
  id SERIAL PRIMARY KEY,
  bit_sheet_id INTEGER REFERENCES bit_sheets(id) ON DELETE CASCADE,
  -- Set instead of bit_sheet_id for a standalone 'production'-type project
  -- (an imported screenplay with no story-agent chain behind it at all).
  concept_id INTEGER REFERENCES concepts(id) ON DELETE CASCADE,
  content JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  feedback TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE script_breakdowns (
  id SERIAL PRIMARY KEY,
  scene_list_id INTEGER REFERENCES scene_lists(id) ON DELETE CASCADE,
  content JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  feedback TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE shoot_schedules (
  id SERIAL PRIMARY KEY,
  scene_list_id INTEGER REFERENCES scene_lists(id) ON DELETE CASCADE,
  content JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  feedback TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE screenplay_scenes (
  id SERIAL PRIMARY KEY,
  scene_list_id INTEGER REFERENCES scene_lists(id) ON DELETE CASCADE,
  episode_index INTEGER,
  scene_index INTEGER NOT NULL,
  content JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  feedback TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Real-world data attached directly onto the Script Breakdown's own lists,
-- not AI-generated content: cast confirmed against a character
-- (character_name = the character's label, category='artist'), a confirmed
-- real location/photo against a Location List entry (character_name = that
-- location's English name, reusing the same link column, category=
-- 'location'), department crew, or a general master crew list entry. Kept
-- as its own table (plain columns, not JSONB like everything else) since
-- this is user-entered data the app never regenerates, and photos are
-- files on disk (photo_path is a relative path under the backend's
-- uploads/ directory), not something to inline as JSON.
CREATE TABLE crew_members (
  id SERIAL PRIMARY KEY,
  scene_list_id INTEGER REFERENCES scene_lists(id) ON DELETE CASCADE,
  category TEXT NOT NULL, -- 'artist' | 'location' | 'art_department' | 'costume_department' | 'crew'
  character_name TEXT,
  name TEXT NOT NULL,
  role TEXT,
  contact_number TEXT,
  photo_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single-row table (this is a local single-user app, not multi-tenant)
-- holding the Google OAuth tokens for the "Connect Google Contacts"
-- feature, so cast/crew/location entries can be picked from the user's
-- real Google Contacts instead of typed by hand.
CREATE TABLE google_auth_tokens (
  id SERIAL PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expiry_date BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Real named logins for the people this project gets shared with, so the
-- app can tell them apart and enforce different permissions per role —
-- 'admin' (the filmmaker) sees everything including Story & Screenplay and
-- is the only one who can import/analyze a script; 'production_manager' is
-- a per-project team account doing ongoing production work (Crew & Cast,
-- Shoot Schedule generation) once the admin hands them an analyzed script;
-- 'director' is review-only (approve / request changes) so two people can
-- never silently overwrite each other's work on the same bulk-replace
-- action. concept_id scopes a non-admin login to exactly one project —
-- NULL for admin (who isn't scoped at all).
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL, -- 'admin' | 'director' | 'production_manager'
  concept_id INTEGER REFERENCES concepts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
