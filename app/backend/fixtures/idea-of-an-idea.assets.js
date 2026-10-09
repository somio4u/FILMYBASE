// TEST FIXTURE — NOT real silent-agent output.
//
// The real silent agent (generateAiMovieAssetExtraction) needs a live Gemini
// key, which the sandbox does not have. This file is a HAND-WRITTEN stand-in
// built only from what the "Idea of an Idea" screenplay itself says (its
// character sheet, props list, locations table and scenes), in the same
// shape the agent now produces. It exists so the Production Dossier can be
// tried end-to-end on a real screenplay. Nothing here comes from a model.
//
// `missing` lists things the screenplay does NOT settle (or contradicts), so
// the Dossier has genuine review items to show.

const d = (en) => ({ en, hi: "" });

export const IDEA_OF_AN_IDEA_TITLE = "[TEST] Idea of an Idea (अधूरे ख्याल)";

export const IDEA_OF_AN_IDEA_ASSETS = {
  characters: [
    {
      name: "Rahul Mohapatra",
      aliases: ["Rahul"],
      visualDescription: d(
        "25-year-old Odia Brahmin office worker from Nua Sahi, Cuttack. Lean-athletic, about 5'9\", slim shoulders. Handsome, clean-shaven, sharp jawline, short side-parted black hair, warm brown eyes, light wheatish skin. Calm, slightly tired eyes; soft smile when happy. A thin sacred thread (janeu) is faintly visible under his open collar in morning/home shots, never mentioned in dialogue."
      ),
      sceneRefs: ["Scene 1", "Scene 2", "Scene 3", "Scene 4", "Scene 5", "Scene 6", "Scene 7", "Scene 8", "Scene 9", "Scene 10", "Scene 11", "Scene 12"],
      states: ["Morning / office", "Nightwear", "Dream king (Scene 10 only)"],
      costumes: [
        { name: "Morning / office look", description: "White full-sleeve formal shirt (sleeves down), navy slim-fit trousers, loosely knotted maroon necktie, black leather formal shoes (NOT the high-ankle boot), silver analog watch on left wrist, black leather sling bag." },
        { name: "Nightwear", description: "Plain grey round-neck t-shirt and pajama (opening seconds, if needed)." },
        { name: "King's royal costume (dream)", description: "Ornate dark-maroon-and-gold robe and a simple gold crown; dream-logic only, should clash slightly with the real-world tone." },
      ],
      missing: ["back view and profile views", "hair texture in profile (side-parted)", "how he looks after a night in the same clothes (Scene 11 — 'still in his regular clothes')"],
    },
    {
      name: "The Black Figure",
      aliases: ["The Ideas", "The Figure", "Black Figure"],
      visualDescription: d(
        "A featureless, faceless figure in a matte pitch-black full-body suit (spandex/latex look) covering head to toe, with a smooth blank black mask: no eye-lenses, no emblem, no texture pattern. Lean-athletic, broad shoulders tapering to a narrow waist, poised and alert, unnaturally still, never blinks, head tilts slightly when observing Rahul. Only the one that speaks in Scene 10 has a voice: deep, calm, slightly echoing, gentle like a patient teacher."
      ),
      sceneRefs: ["Scene 2", "Scene 3", "Scene 4", "Scene 5", "Scene 9", "Scene 10"],
      states: ["Single watcher", "The speaking Figure (Scene 10)", "Crowd of thousands (Scene 10)"],
      costumes: [{ name: "Matte black full-body suit", description: "Seamless, matte, no emblem or pattern; glossy enough in close-up (Scene 10, shot 10.6) to show a warped reflection of the king's robe." }],
      missing: [
        "seated pose reference",
        "CONFLICT: the character sheet says the mask is matte, but Scene 10 shot 10.6 needs it glossy enough to reflect the king's robe",
        "DECISION: the silhouette is based on Spider-Man, a trademarked character; decide how close the design may be",
        "CONFLICT: the character sheet puts the group version in a 'waiting room', but the screenplay's crowd is in the desert (Scene 10)",
      ],
    },
    {
      name: "Debashish",
      aliases: [],
      visualDescription: d("Rahul's office friend from Berhampur, Ganjam district. Chubby build, checkered shirt, glasses; casual, joking tone."),
      sceneRefs: ["Scene 5"],
      states: [],
      costumes: [{ name: "Office casual", description: "Checkered shirt." }],
      missing: ["age", "hair and skin tone", "trousers and footwear"],
    },
    {
      name: "Biswajit",
      aliases: [],
      visualDescription: d("Rahul's office friend from Sambalpur district. Thin build, plain t-shirt under an office lanyard; more serious, concerned tone."),
      sceneRefs: ["Scene 5"],
      states: [],
      costumes: [{ name: "Office casual", description: "Plain t-shirt with office lanyard." }],
      missing: ["age", "hair and skin tone", "trousers and footwear"],
    },
    {
      name: "The Boss",
      aliases: ["Boss"],
      visualDescription: d("Mid-40s, pot-belly, half-sleeve formal shirt tucked in, thick moustache, reading glasses pushed up on his forehead. Loud and short-tempered; heard scolding a junior employee, only partially seen."),
      sceneRefs: ["Scene 4"],
      states: [],
      costumes: [{ name: "Half-sleeve formal shirt", description: "Tucked in; colour not specified." }],
      missing: ["name (only called 'Boss')", "shirt and trouser colours"],
    },
    {
      name: "The Receptionist",
      aliases: ["Receptionist", "Nurse"],
      visualDescription: d("Woman in her 30s, white clinic coat over salwar-kameez, hair in a bun, seated behind a glass-window counter with a token-number machine; calls patients by pressing a button and speaking into a small mic."),
      sceneRefs: ["Scene 6", "Scene 10"],
      states: [],
      costumes: [{ name: "Clinic coat", description: "White coat over salwar-kameez." }],
      missing: ["salwar-kameez colour", "name"],
    },
    {
      name: "The Psychiatrist",
      aliases: ["Doctor"],
      visualDescription: d("Man in his late 40s, salt-and-pepper hair, thin-framed spectacles, white coat over a light-blue shirt. Calm, composed, measured, slightly dismissive: treats Rahul's complaint as ordinary work stress."),
      sceneRefs: ["Scene 7"],
      states: [],
      costumes: [{ name: "Clinic coat", description: "White coat over a light-blue shirt." }],
      missing: ["name", "trousers and footwear"],
    },
    {
      name: "The Shopkeeper",
      aliases: ["Shopkeeper"],
      visualDescription: d(""),
      sceneRefs: ["Scene 8"],
      states: [],
      costumes: [],
      missing: ["any description at all (appears in Scene 8 shot 8.1 only; the character sheet does not describe him)"],
    },
  ],

  properties: [
    { name: "Wilting potted plant", aliases: ["The plant"], visualDescription: d("Terracotta pot, drooping brown-edged leaves, dry cracked soil, sitting outside the apartment door on the corridor floor."), sceneRefs: ["Scene 2", "Scene 12"], states: ["Wilting / dry", "Replanted with fresh soil and watered"], missing: ["plant species", "pot size"] },
    { name: "High-ankle boot", aliases: ["The boot"], visualDescription: d("Brown leather, slightly worn, taller than normal ankle shoes, lying beside the wilting plant; slightly muddy. Never explained in dialogue: a deliberate visual mystery."), sceneRefs: ["Scene 2", "Scene 12"], states: ["Lone boot"], missing: ["DECISION: single boot or a pair (list says 'single/pair'; Scenes 2 and 12 say 'lone')", "which foot"] },
    { name: "Black leather office bag", aliases: ["Office bag", "Sling bag"], visualDescription: d("Rahul's black leather sling bag, worn on one shoulder."), sceneRefs: ["Scene 1", "Scene 9"], states: [], missing: ["size and strap detail"] },
    { name: "Silver wristwatch", aliases: ["Watch"], visualDescription: d("Silver analog watch on Rahul's left wrist."), sceneRefs: [], states: [], missing: ["dial and strap detail", "no scene shows it in an action beat"] },
    { name: "Traffic signal pole", aliases: ["Traffic light"], visualDescription: d("Standard Indian traffic light (red/yellow/green); the road on the green-light side is eerily empty."), sceneRefs: ["Scene 3"], states: ["Red for Rahul", "Green for Rahul"], missing: ["pole style and countdown timer or not"] },
    { name: "Rahul's black hatchback car", aliases: ["The car", "Hatchback"], visualDescription: d("Black hatchback car, recommended over a motorbike for consistent shots. Odisha OD-series number plate."), sceneRefs: ["Scene 3"], states: [], missing: ["DECISION: the props list says 'motorbike or hatchback (pick one)'; make/model not chosen", "number plate text"] },
    { name: "Paper coffee cup", aliases: ["Coffee cup"], visualDescription: d("Paper cup, office-pantry branded, filled from the coffee machine with rising steam."), sceneRefs: ["Scene 5"], states: ["Empty", "Full, steaming"], missing: ["brand or logo"] },
    { name: "Clinic token display board", aliases: ["Number board"], visualDescription: d("Small red digital number display, wall-mounted above the reception window."), sceneRefs: ["Scene 6", "Scene 10"], states: ["Shows 12", "Shows 14"], missing: ["board size", "exact digit style"] },
    { name: "Manual token-calling system", aliases: ["Token mic"], visualDescription: d("Button and small mic the receptionist uses to call numbers out loud: the 'problem' Rahul's idea would solve."), sceneRefs: ["Scene 6", "Scene 10"], states: [], missing: ["what the button and mic look like"] },
    { name: "Gardening kit (trowel, mud bucket, watering can)", aliases: ["Watering can", "Mud bucket"], visualDescription: d("Small gardening trowel, a small bucket of fresh mud, and a small watering can, used when Rahul replants and waters the plant."), sceneRefs: ["Scene 12"], states: [], missing: ["Scene 12 never shows the trowel (only bucket and watering can)", "where Rahul got them (not shown)"] },
    { name: "Bedsheet and pillow", aliases: ["Bed"], visualDescription: d("Rahul's bedsheet and pillow for the bedroom and wake-up shots."), sceneRefs: ["Scene 1", "Scene 11"], states: ["Made, morning", "Slept in (Scene 11)"], missing: ["colours and pattern"] },
    { name: "Prescription and pad", aliases: ["Prescription pad", "Prescription"], visualDescription: d("Doctor's prescription pad and pen; he tears off one prescription sheet and hands it to Rahul."), sceneRefs: ["Scene 7", "Scene 8", "Scene 9"], states: ["Pad on doctor's desk", "Folded loose sheet in Rahul's pocket"], missing: ["CONFLICT: Scene 9 shot 9.1 shows the 'prescription pad' at Rahul's home, but Scene 7 has the doctor tear off a single sheet, so only the sheet should be there", "prescription handwriting text"] },
    { name: "Medicine strip", aliases: ["Pill strip"], visualDescription: d("Small pill strip handed to Rahul, later left unopened on his home table."), sceneRefs: ["Scene 7", "Scene 9"], states: ["Unopened"], missing: ["strip colour and printed name"] },
    { name: "Beer bottles", aliases: ["Beer"], visualDescription: d("4-6 glass beer bottles, local Indian brand style, with condensation, bought on the way home in a paper bag."), sceneRefs: ["Scene 8", "Scene 9"], states: ["Full, condensation", "Empty, accumulating"], missing: ["brand look (fictional label needed)", "exact count (list says 4-6)"] },
    { name: "Plain wooden dining chair", aliases: ["Dining chair"], visualDescription: d("Plain wooden dining chair in Rahul's empty living room; he sits here, with a small side table beside it."), sceneRefs: ["Scene 9"], states: [], missing: ["the small side table is used in Scene 9 but is not in the props list"] },
    { name: "Royal throne chair", aliases: ["Throne"], visualDescription: d("Ornately carved wooden-and-gold throne, standing alone and incongruous in open desert sand."), sceneRefs: ["Scene 10"], states: [], missing: ["scale and height", "carving style"] },
  ],

  environments: [
    { name: "Rahul's bedroom", aliases: ["Bedroom"], visualDescription: d("Interior. Soft warm window light with sleepy blue-gold tones; small wall mirror; half-open curtain. Pastel walls."), sceneRefs: ["Scene 1", "Scene 11"], states: ["Early morning", "Sunrise, warmer gold (waking, Scene 11)"], missing: ["floor plan", "where the mirror and bed sit relative to the door"] },
    { name: "Apartment entrance corridor", aliases: ["Corridor", "Apartment entrance"], visualDescription: d("Nua Sahi, Cuttack: slightly overexposed daylight, a narrow old-town lane visible outside, weathered plaster walls, a dusty neglected corner holding the wilting plant and the boot. Shoe-rack near the door."), sceneRefs: ["Scene 2", "Scene 12"], states: ["Neglected morning (Scene 2)", "Softer, hopeful light, plant being watered (Scene 12)"], missing: ["corridor length (a figure stands 'far down the corridor' in 2.6)", "where the parking area is relative to the door"] },
    { name: "Street outside Rahul's building", aliases: ["Nua Sahi street"], visualDescription: d("Bright, bustling but not crowded old-Cuttack lane: low buildings, narrow bylanes, occasional cycle-rickshaw, modern two-wheelers/EVs mixed in; Odia-script shop signage in the background."), sceneRefs: ["Scene 3"], states: ["Morning"], missing: ["no shot in the screenplay is set here, only mentioned in the locations table"] },
    { name: "Traffic signal junction", aliases: ["Signal junction"], visualDescription: d("Cuttack-Bhubaneswar commute route: wide open road, harsh sunlight, heat haze, eerily empty on the green side, OD-series number plates on parked vehicles."), sceneRefs: ["Scene 3"], states: ["Morning"], missing: ["junction layout and the road divider the Figure stands on", "camera axis for the car"] },
    { name: "Office, Bhubaneswar", aliases: ["Office", "Office workstation"], visualDescription: d("Modern IT-park style building. Interior: cool fluorescent light, open floor of cubicles, glass cabins."), sceneRefs: ["Scene 4"], states: ["Exterior", "Interior workstation"], missing: ["exterior is listed in the locations table but no shot uses it", "Rahul's cubicle position"] },
    { name: "Office pantry", aliases: ["Pantry", "Coffee machine corner"], visualDescription: d("Warm artificial light, coffee machine with steam, a counter. (The character sheet calls it a cafeteria/coffee scene.)"), sceneRefs: ["Scene 5"], states: [], missing: ["layout"] },
    { name: "Psychiatrist clinic waiting room", aliases: ["Waiting room"], visualDescription: d("Clinical white and pale green walls, rows of plastic chairs, tube-lights, sterile cold light; reception glass window with a red digital number board."), sceneRefs: ["Scene 6"], states: ["Afternoon"], missing: ["floor plan", "where the cabin door is"] },
    { name: "Doctor's cabin", aliases: ["Cabin"], visualDescription: d("Small calm cabin: wooden desk, laptop, prescription pad, framed certificates, one visitor chair facing the desk; warm desk-lamp light and wood-panel tones."), sceneRefs: ["Scene 7"], states: ["Afternoon"], missing: ["certificate wording", "window or no window"] },
    { name: "Wine/beer shop counter", aliases: ["Beer shop"], visualDescription: d("Roadside liquor counter at dusk, fading light, neon shop signage glowing faintly."), sceneRefs: ["Scene 8"], states: ["Evening"], missing: ["shop signage text (Odia script)"] },
    { name: "Rahul's living room", aliases: ["Living room"], visualDescription: d("Small tidy 1BHK, empty and quiet at night: single dim bulb, long shadows, a small brass diya/puja corner, a shelf with books, pastel walls."), sceneRefs: ["Scene 9"], states: ["Night"], missing: ["floor plan and where the Figure's corner is", "where the puja corner is"] },
    { name: "Dream desert", aliases: ["Desert", "Dream space"], visualDescription: d("Boundless sand dunes under a pale, sunless, dusty sky. Flat harsh directionless light, no horizon landmarks; thousands of black figures in silhouette stand against the horizon."), sceneRefs: ["Scene 10"], states: ["Dream only"], missing: ["dune scale and texture", "how far apart the rows of figures stand"] },
  ],

  otherAssets: [
    { kind: "sound", name: "Black Figure hum", aliases: ["Heartbeat hum"], visualDescription: d("Very faint low-frequency hum or heartbeat whenever the Figure is on screen; vanishes the instant it leaves frame. In the desert it swells into a deep, wide, wind-like drone."), sceneRefs: ["Scene 2", "Scene 3", "Scene 4", "Scene 5", "Scene 9", "Scene 10"], states: ["Faint", "Swelling drone (desert)"], missing: ["reference sound"] },
    { kind: "crowd / visual effect", name: "Desert figure crowd", aliases: ["Thousands of figures"], visualDescription: d("Thousands of identical black figures in rows. Notes advise generating one clean repeatable figure and compositing it in rows rather than prompting 'thousands'."), sceneRefs: ["Scene 10"], states: [], missing: ["row spacing and count", "compositing method decision"] },
    { kind: "sign", name: "Odia-script shop signage", aliases: [], visualDescription: d("Odia-script shop signs in the background of street scenes (blurred or out of focus is fine)."), sceneRefs: ["Scene 3", "Scene 8"], states: [], missing: ["exact text (a real sign needs exact approved wording)"] },
    { kind: "sign", name: "OD-series number plates", aliases: ["Number plates"], visualDescription: d("Odisha (OD-series) number plates visible on vehicles, including parked ones at the junction."), sceneRefs: ["Scene 3"], states: [], missing: ["exact plate text for Rahul's car"] },
    { kind: "graphic", name: "Glowing TV screen overlay", aliases: ["Idea overlay"], visualDescription: d("A faint ghostly glowing TV-screen concept laid over the reception counter in the flashback insert (shot 10.7): the 'idea' itself."), sceneRefs: ["Scene 10"], states: [], missing: ["what the screen shows (number text)", "overlay style"] },
  ],
};
