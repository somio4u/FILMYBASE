// A SCRIPTED stand-in for the AI, used ONLY when DRAFT_AGENT_MOCK=1 (development and browser tests). It never runs in normal use.
// It makes predictable, labelled changes so the whole Draft Agent flow can be exercised end to end without calling Google.
const mutate = (v) => {
  if (typeof v === "string") return v.length > 6 && !v.includes("[revised]") ? `${v} [revised]` : v;
  if (Array.isArray(v)) return v.map(mutate);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "type" ? x : mutate(x)]));
  return v;
};
export const scriptedAgentModels = {
  async json(draft, agentId, prompt) {
    if (prompt.includes("routing step")) {
      const t = /INSTRUCTION \(verbatim\): """([\s\S]*?)"""/.exec(prompt)?.[1] ?? "";
      if (/second draft|new draft|villain|keep the/i.test(t)) return { intent: "NEW_DRAFT", confidence: 0.9, summary: "A big revision that should be a new draft.", targets: [{ type: "whole" }], mustKeep: /keep (the )?([^,.;]+)/i.test(t) ? [/keep (the )?([^,.;]+)/i.exec(t)[2]] : [], mustChange: [] };
      if (/try|what if|alternative/i.test(t)) return { intent: "ALTERNATIVE", confidence: 0.85, summary: "Try this without changing the draft.", targets: [{ type: "ending" }] };
      if (/scenes? \d/i.test(t)) return { intent: "SCOPED_REWRITE", confidence: 0.85, summary: "Rewrite those scenes.", targets: [] };
      return { intent: "LOCAL_EDIT", confidence: 0.9, summary: "Change the selected piece.", targets: [{ type: "selection" }] };
    }
    if (prompt.includes("Sort EVERY piece")) {
      const keys = [...prompt.matchAll(/^\[([^\]]+)\] /gm)].map((m) => m[1]);
      const scenes = keys.filter((k) => /^(b\d+s\d+|e\d+s\d+)$/.test(k));
      return { modified: scenes.slice(1, 2).map((key) => ({ key, why: "the villain changes here" })), indirect: scenes.slice(2, 3).map((key) => ({ key, why: "refers to the villain" })), removed: [], added: [{ label: "A new confrontation", why: "the new conflict needs it" }] };
    }
    if (prompt.includes("REVISED DRAFT")) return { summary: "The villain becomes the hero's brother; the opening and hero stay.", revisedSynopsis: "A dancer must face her own brother, who leads the storm cult.", revisedSynopsisHi: "x", seasonArc: "The brother arc runs through the season.", episodes: [{ index: 1, title: "The brother", synopsis: "The brother appears." }], sequenceOutline: [{ label: "Act 2", change: "The brother is revealed." }] };
    const m = /CURRENT \(JSON\):\n([\s\S]*?)\n\nReturn JSON only/.exec(prompt);
    if (m) return mutate(JSON.parse(m[1]));
    return { text: "A rewritten idea." };
  },
};
