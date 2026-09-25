// The Akhada story bible's Synopsis, Characters, Three-Act Structure, and
// Beat Sheet, already fully written by the user across their uploaded
// files (see the .md files in this folder) -- laid out here in English so
// the "fill-akhada-stages" endpoint can hand it to Gemini for translation
// ONLY (never invention). Nothing below is generated; it is a direct,
// faithful restatement of the user's own material, reshaped into the
// app's stage schemas.

export const AKHADA_FIXED_SYNOPSIS = {
  logline:
    "Year 5000. Prayer is a crime across the galaxy. Only one temple is left, and the man who once died for it has come back to tear it down. Five strangers wake as the god's last guardians — and must learn the one thing he never did: some things are not earned, they are given.",
  premise:
    "Five ordinary strangers in a future Puri — an engineer, a strategist, a cook, a courier, and a librarian's daughter — are pulled out of frozen time into a timeless void and told they are the next guardians of the last god left in a galaxy where prayer is now a crime. Trained by their own past-life students, they lose their teacher at the cathartic midpoint and are forced to carry the Lord's journey themselves, hunted across the galaxy by Kalapahada, a guardian who broke long ago and now wants the sacred Brahma to make himself immortal. Each hero hides from their own element behind an old wound; each must reopen it to survive. The film ends where it began: at the temple, on time, with the five no longer strangers who owe something, but a new Akhada, on watch.",
  toneGenre:
    "A large-scale Indian mythological science-fiction actioner, set 3000 years in the future but grounded in real Jagannath Puri ritual and history — epic in scope, devotional at its core, with a strong emotional throughline about grace versus guilt (devotion is not a transaction).",
  targetAudience:
    "Mainstream Odia theatrical audiences as a big single-screen and multiplex event film, and wider Indian audiences drawn to large-scale mythological/spectacle-action films with genuine devotional weight.",
};

export const AKHADA_FIXED_CHARACTERS = [
  {
    name: "Rudra",
    want: "To keep everyone safe by being careful — to follow the rules, hold the line, never take a risk that could go wrong.",
    need: "To stop hiding his fire and trust himself enough to actually burn, even if it costs him.",
    arc: "A cautious engineer terrified of his own power, whose careful over-push of the Receiver causes the Breach. At the climax he walks into the lathi's killing power to save the others, is forged into a warrior, and becomes its bearer.",
  },
  {
    name: "Meera",
    want: "To be right — to win every argument with a cold, exact number, and never be blamed again for a mistake.",
    need: "To accept that some things can't be counted, and that being right isn't the same as being good.",
    arc: "A strategist who runs numbers on human lives to avoid ever being wrong again. She softens after watching the Maha Guru let force pass through him, and delivers the film's answer to Kalapahada: devotion was never a transaction.",
  },
  {
    name: "Omm",
    want: "To be needed — to carry every load himself so no one else ever gets hurt because of him.",
    need: "To let others help, and to trust that putting a weight down isn't the same as failing.",
    arc: "A warm cook and healer hiding an old guilt behind constant care for others. Wounded early in the Akhada, he ultimately yields his own timing at the climax and pulls Tara back from drifting.",
  },
  {
    name: "Samir",
    want: "To buy back his family's forgiveness — to keep sending money and never ask for anything in return.",
    need: "To stop trying to purchase forgiveness and actually show up in the moment he once ran from.",
    arc: "A grave courier who freezes at key moments, running from an old wreckage. He gives away the very chip he was paid to deliver, and at the climax holds the exact kind of gap he once froze at.",
  },
  {
    name: "Tara",
    want: "To prove her visions are a symptom, not a truth — to stay blunt, data-first, and unfooled by mysticism.",
    need: "To accept a truth she can't prove, and trust what she feels as much as what she can measure.",
    arc: "A sceptic whose fractured mind gave her real visions she's spent years dismissing as illness. She loses her father at Granthaloka, becomes the living conduit for the final joined strike, and finally believes her family's old prophecy at the end.",
  },
  {
    name: "Kalapahada",
    want: "To recover the sacred Brahma, force open the great portal, and drink the Manthan's immortality for himself.",
    need: "To let go of the belief that devotion owed him anything in return.",
    arc: "A protector chosen long ago who broke, came to hate the god he once served, and refused the cycle of rebirth to return with all his memory intact. He is undone not by force but by Meera's answer — that grace was never a transaction he was owed or denied.",
  },
];

export const AKHADA_FIXED_THREE_ACT = [
  {
    actName: "Act 1 — The Start & The Breach",
    description:
      "Future Puri prepares for the Rath Yatra as its energy grid fails. Five strangers — Rudra, Omm, Meera, Tara, Samir — live separate lives that brush past each other once during the Pahandi. Rudra's careful over-push of the failing Wireless Orbital Receiver tears the sky open, and a shadow army pours through.",
    turningPoint:
      "The old guardian, the Rakhyaka, fights the invading army to a standstill, then freezes all of time in Puri and pulls the five frozen strangers into the timeless Akhada.",
  },
  {
    actName: "Act 2A — The Timeless Akhada",
    description:
      "The five wake inside the Akhada, a timeless void built from the sacred danda, and are told they are the god's new guardians. Trained by clan mentors who are secretly their own past-life students, each hero is forced to confront the element they've been hiding from — until a beast slips through the still-open portal into the Akhada itself and infects a beloved clan member.",
    turningPoint:
      "To save the Akhada — and the entire protector cycle — from collapsing forever, the five must put down one of their own and rush back to Earth before they feel ready.",
  },
  {
    actName: "Interval — The Guardian's Fall",
    description:
      "Time resumes on the Grand Road mid-battle. The five hold back from killing the zombified pilgrims and fight instead for the portal, but none of them can hold the lathi — only the wounded Rakhyaka can carry it into the sky to try to seal the tear.",
    turningPoint:
      "The shadow army fuses into one monster and strikes the Rakhyaka down in front of the Gundicha Temple. Dying, he tells the five none of them can hold the lathi yet, and that they must take the Lord and hide Him. \"The teacher is gone. The war just started.\"",
  },
  {
    actName: "Act 2B — The Journey",
    description:
      "Kalapahada is revealed, forces the lathi to obey him, and sets a nine-day clock for the Lord's return. As the five become galaxy-famous for the Grand Road battle, they carry the Lord to Tara's home world, Granthaloka, where the library names their enemy for the first time — and where Tara loses her father defending the archive. A direct assault to take the lathi back fails; fighting Kalapahada only feeds him.",
    turningPoint:
      "Rock bottom: Tara's data proves Rudra's own caution helped tear the sky open in the first place. In the wreck of that discovery, each hero finally sets their private guilt down and understands Kalapahada's whole plan — the Brahma, the portal, the Samudra Manthan — and turns the ship for home.",
  },
  {
    actName: "Act 3 — The Climax: Samudra Manthan",
    description:
      "Kalapahada traps the five in an illusion they can't out-fight — until Rudra stops fighting, takes the lathi's killing power, and is forged into its true bearer, shattering the maya. In the real world, Kalapahada seizes the Lord in front of the Sri Mandir and carries Him out to sea, tearing open a portal and beginning a dark Samudra Manthan to drink his own immortality.",
    turningPoint:
      "The five yield instead of striking — one thread of power through Tara, led by Rudra. Meera answers Kalapahada's oldest wound directly: devotion was never a transaction, never owed and never withheld, and the strike passes clean through him. The Lord enters the temple on time at Niladri Bije, and the five become the new Akhada, on watch.",
  },
];

export const AKHADA_FIXED_BEATS = [
  { title: "The Failing Receiver", description: "A ship tears across future Puri toward the Wireless Orbital Receiver, whose failing power beams reveal a city, and a faith, running out of energy." },
  { title: "Rath Yatra Morning", description: "On Rath Yatra morning, a Council broadcast tells the record crowd that Earth is the last protected holy place left in a galaxy where prayer is now a crime." },
  { title: "The First Zombify", description: "Off-world, shadow-soldiers break into a hidden prayer room and turn a praying man into one of them — the first glimpse of how the shadow army grows." },
  { title: "Pushed Past The Line", description: "On the Receiver gantry, Rudra overrides Omm's warning and pushes the failing power output past the safe line, by the book, to keep the city lit." },
  { title: "Rudra's Sister", description: "Rudra calls his sister, who is in the crowd in Puri today, and a flash of an old Martian war memory shows exactly why he's this careful." },
  { title: "Meera's Cold Number, Tara Ignored", description: "At the Global Council, Meera coldly quantifies an acceptable sacrifice while Tara's warning that the sky over the temple is 'folding' gets waved off as noise." },
  { title: "Samir's Drop", description: "Courier Samir delivers an experimental nav chip mid-ritual and quietly routes his fee to a family he won't name." },
  { title: "The Pahandi (Song)", description: "During the swaying Pahandi procession, the five strangers brush past each other once in the crowd, none of them noticing." },
  { title: "The Breach Begins", description: "As crowd power-demand spikes, Rudra pushes the Receiver to full and the sky over the temple begins to ripple wrong." },
  { title: "The Sky Tears", description: "The last sky-shield gives way, the sky tears open, and hundreds of shadow-soldiers fall into the festival crowd, turning it into a stampede." },
  { title: "The Rakhyaka Fights", description: "The old guardian, the Rakhyaka, walks into the invading army alone and fights it to a standstill with nothing but a wooden staff, until a heavy strike wounds him badly." },
  { title: "The Freeze", description: "Knowing he cannot win, the Rakhyaka strikes his staff to the ground, freezes all of time in Puri, and pulls five frozen strangers into the Akhada with a spark of light." },
  { title: "Waking In The Akhada", description: "The five wake on a floating, timeless wrestling-ground as the dead Biswabasu clan bows to them and the Rakhyaka names them the god's new guardians." },
  { title: "The Origin Montage", description: "Memory-light shows the clan's ancient origin with Nila Madhava, the carving of the neem-wood danda, and the danda's first-ever choice of five protectors instead of one." },
  { title: "An Enemy With No Name", description: "The Rakhyaka reveals only that the enemy was once one of them, a chosen protector turned against the Lord by something he won't name." },
  { title: "Training Begins", description: "Each hero trains under a clan mentor who is secretly their own past-life student — Omm's stone won't answer him, Rudra clamps down his heat, Meera's water comes too easily, Samir overshoots, and Tara learns a needle-thin portal at the cost of her grip on the present." },
  { title: "The Training Fight", description: "A real sparring bout reveals the five as they truly are: Omm underrated, Samir overrated, Meera the sharpest, and Rudra — still refusing to loose his fire — looking like the weakest of them all." },
  { title: "The Failed Joining", description: "The Rakhyaka explains that the enemy feeds on any force thrown at him; the five try to join their five powers into one, and the collision wounds Omm badly. Alone, Tara has a silent vision she tells no one." },
  { title: "A Beast In The Akhada", description: "Something drops through the still-open frozen portal into the sacred Akhada itself — a beast the timeless world was never built to face." },
  { title: "The Hard Choice", description: "A beloved clan mentor is infected and turning; the five must put him down themselves, learning that if the dark power takes the Akhada, the entire protector cycle ends forever. They rush back to Earth before they're ready." },
  { title: "Time Resumes", description: "The five land back on the Grand Road as time snaps on around them, turning as one to face the still-mid-lunge shadow army." },
  { title: "The Zombify Horror", description: "The five cut loose for the first time on Earth, then realize the enemy is touching fleeing pilgrims and turning them into shadow-soldiers — nearly 5000 souls changing before their eyes. They refuse to kill the once-human demons." },
  { title: "The Lathi Problem", description: "None of the five can hold the silk-wrapped danda; only the Rakhyaka can, so Samir lifts him into the sky toward the portal while the others fight to move the Lord toward the Gundicha Temple." },
  { title: "The Guardian Falls", description: "The shadow army fuses into one monster and strikes the Rakhyaka down in the sky; he falls before the Gundicha Temple, and his last spell raises a dome of light over it as the danda spears the ground." },
  { title: "The Last Order", description: "Dying under the dome, the Rakhyaka tells the five none of them can hold the lathi yet — they must take the Lord and hide Him. They slip Him away in secret. INTERVAL: \"The teacher is gone. The war just started.\"" },
  { title: "Kalapahada Revealed", description: "In the empty sanctum, a tall armored figure removes his faceless helmet, revealing Kalapahada — and the place where the Lord should be is empty." },
  { title: "The Lathi Chained, The Clock Set", description: "Kalapahada forces the resisting danda to obey him by dark power, then taunts the fled Lord: the Yatra must complete, but he won't be allowed to enter His temple — a nine-day countdown begins." },
  { title: "Galaxy-Famous, Building An Army", description: "Broadcasts across a hundred worlds replay the five's stand on the Grand Road as heroes, while Kalapahada's fleet sweeps world after world, quietly building a growing shadow army as he waits." },
  { title: "Granthaloka Welcome (Song)", description: "The five bring the Lord to Tara's home world, Granthaloka, the galaxy's great library, where a devotional welcome greets Him — and Tara reunites, uneasily, with her father." },
  { title: "The Name In The Library", description: "In the library's living digital archive, the heroes summon the real Madala Panji chronicle, which finally speaks the enemy's name — Kalapahada — and tells his story." },
  { title: "The Scale Of It", description: "A distress feed shows a whole colony world gone dark, its dead risen by the million — proof that Kalapahada isn't chasing the five, he's building an army." },
  { title: "Granthaloka Attacked", description: "Kalapahada's forces fall on Granthaloka; this time the five stand and actively fight to protect the people, not just to flee." },
  { title: "The Father's Fall", description: "Tara's father sacrifices himself sealing the library's archive with his life, pressing an old palm-leaf prophecy verse into her hands before the heroes can reach him." },
  { title: "The Mirror", description: "In the dark of the ship, each hero silently recognizes a piece of themselves in Kalapahada's story — the villain is where each of their own roads leads." },
  { title: "The Maha Guru's Secret (Song)", description: "At a hidden faith-world, a Maha Guru survives a killing blow by letting it pass through him instead of blocking it, and begins to teach the five what they just saw — a lesson that starts to soften Meera." },
  { title: "Feeding The Enemy", description: "The five ambush Kalapahada's flagship to take the lathi back with everything they have, only to watch him absorb all of it and grow stronger — fighting him only feeds him." },
  { title: "Rock Bottom", description: "Tara's long-running data finally resolves: Rudra's own careful over-push of the Receiver helped tear the sky open in the first place. The team fractures under the weight of it." },
  { title: "The Turn", description: "Replaying the Maha Guru's lesson, the five realize force can only pass through a heart that isn't gripping its own guilt. One by one they set their private weights down, piece together Kalapahada's whole plan, and turn the ship for Earth." },
  { title: "The Trap Springs", description: "Coming in toward Earth, reality buckles — the ship is gone, and the five find themselves inside a maya, an illusion Kalapahada built to hold them." },
  { title: "Rudra Is Forged", description: "Trapped in a battle with no exit, the five realize the only way out is to stop fighting; Rudra walks into the chained lathi's killing power with an open heart, is forged into its true bearer, and shatters the illusion." },
  { title: "The Seizing", description: "Back in the real world, as the Lord is carried on foot toward the Sri Mandir, Kalapahada strikes in front of the temple, seizes the idol, and flies Him out to sea." },
  { title: "The Dark Manthan Begins", description: "Far out at sea, Kalapahada draws the sacred Brahma from the idol and tears open a great portal; nagas and danavas pour through as he begins a dark Samudra Manthan to churn out his own immortality." },
  { title: "The Final Battle", description: "The five arrive and, instead of fighting Kalapahada's way, yield — channeling one thread of power through Tara as the living conduit, led by Rudra and the blazing lathi, with Omm pulling Tara back when she drifts." },
  { title: "The Answer", description: "Kalapahada makes his oldest case to Meera — that he gave everything and got nothing back — and she answers that devotion was never a transaction, never owed and never withheld. The threaded strike passes clean through him, and he comes apart into light." },
  { title: "After", description: "In the sudden quiet, the five recover the Brahma, and the Rakhyaka's spirit shines once more in the settling danda before passing on for good." },
  { title: "Niladri Bije", description: "The Lord enters the temple on time, exactly as He has for thousands of years. Rudra plants the spent danda where the Rakhyaka fell, Tara finally believes her family's old prophecy, and the five stand together as the new Akhada, on watch." },
];
