CREATE TABLE IF NOT EXISTS honi_recursive_summaries (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  source_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_honi_recursive_summaries
  ON honi_recursive_summaries(agent_name, thread_id, depth, created_at);

CREATE TABLE IF NOT EXISTS honi_recursive_counters (
  agent_name TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_name, thread_id, depth)
);
