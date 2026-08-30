import { useState, useEffect, useRef } from 'react'
import './App.css'

// Env-driven so the same build works against localhost in dev and the
// deployed Render backend in production (set VITE_BACKEND_URL at build time).
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000'
const CURRENT_CONCEPT_STORAGE_KEY = 'filmmaking-app:currentConceptId'

// Every fetch() in this file targets our own backend — patched once here so
// the session cookie (set by /api/auth/login) rides along on every request
// without having to add `credentials: 'include'` to dozens of call sites
// individually.
const nativeFetch = window.fetch.bind(window)
window.fetch = (url, options = {}) => nativeFetch(url, { ...options, credentials: 'include' })

const LABELS = {
  en: {
    heading: 'Filmmaking App',
    openMenuLabel: 'Open menu',
    closeMenuLabel: 'Close menu',
    usernameLabel: 'Username',
    passwordLabel: 'Password',
    loginButton: 'Log in',
    loggingInLabel: 'Logging in…',
    logoutButton: 'Log out',
    manageUsersButton: 'Manage Users',
    assignProjectPlaceholder: 'Assign to project…',
    roleAdmin: 'Admin',
    roleDirector: 'Director',
    roleProductionManager: 'Production Manager',
    emptyGreeting: 'Type your idea and explore',
    newIdeaButton: 'New Idea',
    regeneratePlaceholder: 'Press Enter for 2 new options, or type feedback first',
    lockedBadgeLabel: 'Locked in',
    sidebarHistoryLabel: 'History',
    sidebarHistoryNote: 'Your saved projects — click one to load it.',
    sidebarNewProject: 'New Project',
    renameProjectPrompt: 'Rename this project',
    renameIconTitle: 'Rename project',
    agentsSectionTitle: 'Agents',
    masterProjectListLabel: 'All Projects',
    storyAgentLabel: 'Story & Screenplay',
    productionAgentLabel: 'Production Management',
    masterProjectListHeading: 'All Projects',
    loadingLabel: 'Loading...',
    ongoingProjectsHeading: 'Ongoing / Pre-Production',
    inDevelopmentProjectsHeading: 'In Development',
    noProjectsInStageNote: 'No projects here yet.',
    noOneAssignedNote: 'No one assigned yet',
    adRoleLabel: 'AD',
    directorRoleLabel: 'Director',
    newProductionButton: 'New Production',
    importScreenplayIntro: "Production Management works from a finished screenplay — it doesn't need to have been written in this app.",
    uploadScreenplayFileButton: 'Upload Screenplay File',
    screenplayFileFormatsNote: 'Supports Final Draft (.fdx), Scrite (.scrite), Word (.docx/.doc), PDF, and plain text.',
    importScreenplayOrPaste: 'Or paste it directly:',
    importScreenplayPlaceholder: 'Paste your full screenplay here…',
    importScreenplayButton: 'Import Screenplay',
    importingScreenplayLabel: 'Reading screenplay...',
    reimportScreenplayButton: 'Re-upload Updated Screenplay',
    reimportScreenplayIntro: "Paste the writer's newer draft below. Scene numbers, cast, contact numbers, and photos you've already entered are kept — you'll get a summary of anything added or no longer found so you can review it.",
    reimportingScreenplayLabel: 'Re-analyzing updated screenplay...',
    confirmReimportScreenplayButton: 'Update Screenplay',
    reimportChangesHeading: 'Screenplay updated — changes found:',
    reimportAddedScenesLabel: 'New scenes',
    reimportRemovedScenesLabel: 'Scenes no longer in the script',
    reimportAddedCharactersLabel: 'New characters',
    reimportRemovedCharactersLabel: 'Characters no longer found (their cast info is kept — remove manually if this is intentional)',
    reimportAddedLocationsLabel: 'New locations',
    reimportRemovedLocationsLabel: 'Locations no longer found (kept — remove manually if intentional)',
    reimportShootScheduleWarning: 'You already have a shoot schedule for this project — since scene numbers or order may have changed, regenerate it to make sure shoot days still match the right scenes.',
    stageIdeaLabel: 'Idea',
    stageSynopsisLabel: 'Synopsis',
    stageCharactersLabel: 'Characters',
    stageBitSheetLabel: 'Bit Sheet',
    stageScreenplayLabel: 'Screenplay',
    stageProductionLabel: 'Production',
    stageBreakdownLabel: 'Script Breakdown',
    stageCrewLabel: 'Crew & Cast',
    stageScheduleLabel: 'Shoot Schedule',
    crewHeading: 'Crew & Cast',
    downloadAllCrewExcelLabel: 'Download All Cast & Crew (Excel)',
    castSectionHeading: 'Cast',
    artDepartmentHeading: 'Art Department',
    costumeDepartmentHeading: 'Costume Department',
    masterCrewHeading: 'Master Crew List',
    crewNameLabel: 'Name',
    crewRoleLabel: 'Role / Designation',
    crewContactLabel: 'Contact Number',
    crewPhotoLabel: 'Photo',
    crewCharacterLabel: 'Character',
    addCrewMemberButton: 'Add',
    removeCrewMemberButton: 'Remove',
    modifyCrewMemberButton: 'Modify',
    noCrewMembersYet: 'None added yet.',
    allCharactersCastNotice: 'All characters are cast.',
    castingActorNamePlaceholder: 'Actor playing this role',
    locationConfirmedNamePlaceholder: 'Confirmed location name / address',
    awaitingFormatPlaceholder: 'Building your pitch deck…',
    revisePitchDeckPlaceholder: 'Type changes for the pitch deck, then press Enter…',
    reviseCharacterSheetPlaceholder: 'Type changes for the characters, then press Enter…',
    reviseThreeActPlaceholder: 'Type changes for the three-act structure, then press Enter…',
    reviseBitSheetPlaceholder: 'Type changes for the bit sheet, then press Enter…',
    reviseSceneListPlaceholder: 'Type changes for the scene list, then press Enter…',
    reviseSchedulePlaceholder: 'Type changes for the shoot schedule, then press Enter…',
    idlePlaceholder: 'Nothing to revise right now — use the buttons above to continue',
    changesChatToggleLabel: 'Ask for changes',
    changesChatHeading: 'Changes',
    changesChatEmptyNote: 'Type a change below and it will show up here, along with what happened.',
    changesChatAppliedMessage: '✅ Done — applied and regenerated.',
    changesChatErrorMessage: '⚠️ Something went wrong — please try again.',
    exportButtonLabel: 'Save Project',
    exportingProjectLabel: 'Saving…',
    connectGoogleContactsButton: 'Connect Google Contacts',
    googleContactsConnectedLabel: '✅ Google Contacts connected',
    googleContactsConnectedNotice: 'Google Contacts connected.',
    googleContactsErrorNotice: 'Could not connect Google Contacts. Please try again.',
    pickFromContactsButton: 'Pick from Google Contacts',
    downloadAuditionSidesButton: 'Download Character Script (PDF)',
    auditionSidesHint: "Every scene this character appears in, with their real dialogue transcribed from the script — or a description of their actions in scenes where they don't speak — so you can send the actor a complete packet for a self-tape audition.",
    sendWhatsAppButton: 'Send via WhatsApp',
    sendingWhatsAppLabel: 'Preparing…',
    invalidPhoneNumberNotice: "This contact number doesn't look valid for WhatsApp.",
    whatsAppShareLinkErrorNotice: 'Could not create the WhatsApp link. Please try again.',
    searchContactsPlaceholder: 'Search contacts…',
    loadingContactsLabel: 'Loading contacts…',
    noContactsFound: 'No matching contacts.',
    importButtonLabel: 'Import Project',
    importInvalidFile: "This doesn't look like a valid exported project file.",
    pinIconTitle: 'Pin project',
    unpinIconTitle: 'Unpin project',
    deleteIconTitle: 'Delete project',
    deleteProjectConfirm: 'Delete this project? This cannot be undone.',
    startStageLabel: 'Start from:',
    startStageIdea: 'Idea',
    startStageSynopsis: 'Synopsis',
    startStageBitSheet: 'Bit Sheet',
    startStageSceneList: 'Scene One-Liners',
    skipPastePlaceholderSynopsis: 'Paste your synopsis or pitch text here…',
    skipPastePlaceholderBitSheet: 'Paste your Bit Sheet (plot points) text here…',
    skipPastePlaceholderSceneList: 'Paste your scene-by-scene one-liners here…',
    skipRuntimeLabel: 'Approximate total runtime (minutes)',
    skipContinueButton: 'Continue',
    skipContinueButtonLoading: 'Working on it…',
    skipQuotaNote: "This will invent short, consistent earlier stages behind the scenes so the rest of the app works normally — costs a few extra AI calls (worth knowing given the daily free-tier limit). Film only for now.",
    instruction: 'Type your movie concept below, then click Generate.',
    placeholder: 'e.g. A fisherman in coastal Odisha finds a boat that returns from the sea empty every full moon...',
    generate: 'Generate',
    generating: 'Generating...',
    storylineSuggestions: 'Storyline suggestions:',
    optionLabel: (n) => `Option ${n}`,
    chooseThisOne: 'Choose this one',
    formatQuestion: 'Is this a film or a web series?',
    filmOption: 'Film',
    seriesOption: 'Web Series',
    episodeCountLabel: 'Number of episodes',
    episodeMinutesLabel: 'Minutes per episode',
    runtimeMinutesLabel: 'Total runtime (minutes)',
    buildPitchDeck: 'Build Pitch Deck',
    buildingPitchDeck: 'Building pitch deck...',
    cancel: 'Cancel',
    premise: 'Premise',
    toneGenre: 'Tone / Genre',
    targetAudience: 'Target Audience',
    majorCharactersHeading: 'Major Characters',
    emotionalCoreLabel: 'Emotional Core',
    conflictLabel: 'Conflict',
    exportAsPdf: 'Export as PDF (Presentation)',
    formatFilm: 'FEATURE FILM',
    formatSeries: (count, minutes) => `WEB SERIES · ${count} EPISODES × ${minutes} MIN EACH`,
    episodeBreakdown: 'Episode Breakdown',
    episodeLabel: 'Episode',
    genericError: 'Something went wrong. Please wait a moment and try again.',
    missingCharacterNamePlaceholder: 'Missed a character? Type their name…',
    addMissingCharacterButton: 'Add Character',
    addingCharacterLabel: 'Adding…',
    ageLabel: 'Age',
    genderMaleLabel: 'Male',
    genderFemaleLabel: 'Female',
    unspecifiedLabel: 'Unspecified',
    directorOverviewHeading: 'Production Status Overview',
    directorOverviewCastLabel: 'Cast',
    directorOverviewLocationsLabel: 'Locations',
    directorOverviewCrewLabel: 'Crew',
    directorOverviewScenesLabel: 'Shoot Progress',
    directorOverviewAllCastFinalized: 'All characters are cast — nothing pending.',
    directorOverviewPendingCastNote: 'Still need to be cast:',
    directorOverviewAllLocationsFinalized: 'All locations are confirmed — nothing pending.',
    directorOverviewPendingLocationsNote: 'Still need to be confirmed:',
    directorOverviewNoCrewNote: 'No crew members added yet.',
    shotLabel: 'Shot',
    pendingLabel: 'Pending',
    showDetailsButton: 'Show scene-by-scene detail',
    hideDetailsButton: 'Hide scene-by-scene detail',
    loadingOverviewLabel: 'Loading production status…',
    findMissingCharactersButton: 'Re-analyze for Missing Characters',
    findingMissingCharactersLabel: 'Scanning script...',
    findMissingCharactersHint: 'Thoroughly re-scans the full script for any character with screen presence not yet in this list — including non-speaking characters — and adds them. Never removes or changes existing entries. Excludes unnamed extras/crowds.',
    foundMissingCharactersLabel: 'Found and added',
    noMissingCharactersFoundLabel: 'No missing characters found — the cast list already covers everyone with screen presence.',
    approveButton: 'Approve',
    requestChangesButton: 'Request Changes',
    approvedBadge: '✅ Approved',
    changesRequestedBadge: 'Revised after feedback:',
    feedbackPlaceholder: 'What would you like changed? e.g. "Make the tone darker" or "The target audience should be younger"',
    submitFeedback: 'Submit Feedback & Regenerate',
    submittingFeedback: 'Regenerating...',
    generateThreeAct: 'Generate Three-Act Structure',
    generatingThreeAct: 'Generating three-act structure...',
    threeActHeading: 'Three-Act Structure',
    controllingIdeaLabel: 'Theme:',
    setupLabel: 'Act 1: Setup',
    confrontationLabel: 'Act 2: Confrontation',
    resolutionLabel: 'Act 3: Resolution',
    lockButton: 'Lock Structure',
    lockedBadge: '🔒 Locked',
    structureFeedbackPlaceholder: 'What would you like changed? e.g. "Add a twist in Act 2" or "The resolution feels rushed"',
    versionHistoryHeading: 'Version History',
    versionLabel: 'Version',
    statusPending: 'Pending',
    statusLocked: 'Locked',
    statusChangesRequested: 'Changes Requested',
    viewButton: 'View',
    hideButton: 'Hide',
    feedbackGivenLabel: 'Feedback:',
    episodeStructuresHeading: 'Episode-by-Episode Three-Act Breakdown',
    generateSceneList: 'Generate Scene One-Liners',
    generatingSceneList: 'Generating scene list...',
    sceneListHeading: 'Scene-by-Scene One-Liners',
    sceneLabel: 'Scene',
    dayLabel: 'DAY',
    nightLabel: 'NIGHT',
    approveSceneListButton: 'Approve Scene List',
    sceneListApprovedBadge: '✅ Scene List Approved',
    sceneListFeedbackPlaceholder: 'What would you like changed? e.g. "Scene 4 needs more tension" or "Merge scenes 2 and 3"',
    approxMinutesUnit: (minutes) => `~${minutes} min`,
    totalRuntimeLabel: (total, target) => `Estimated total: ${total} min (target: ${target} min)`,
    runtimeMismatchNote: 'This is off from the target runtime — use "Request Changes" below to ask for more or fewer scenes.',
    writeSceneButton: 'Write This Scene',
    generatingScreenplayScene: 'Writing scene...',
    screenplayFeedbackPlaceholder: 'What would you like changed about this scene? e.g. "Make the dialogue sharper" or "Add a beat of hesitation before he answers"',
    screenplayCompleteBanner: '🎬 Full screenplay draft complete! This locked structure and final screenplay are ready to hand off to the next stage.',
    screenplayProgressLabel: (drafted, total) => `Screenplay progress: ${drafted} / ${total} scenes written`,
    productionHeading: 'Production Management',
    scriptBreakdownHeading: 'Script Breakdown',
    generateBreakdownButton: 'Analyze Script',
    generatingBreakdownLabel: 'Analyzing script...',
    generateAdSheetButton: 'Generate AD Scene Breakdown Sheet',
    generatingAdSheetLabel: 'Generating AD sheet...',
    downloadAdSheetLabel: 'Download AD Scene Breakdown Sheet (PDF)',
    artistListHeading: 'Artist List (Cast)',
    locationListHeading: 'Location List',
    propsHeading: 'Property List (Props)',
    costumesHeading: 'Costume Changes',
    artHeading: 'Art Department Notes',
    downloadPdfLabel: 'Download PDF',
    downloadExcelLabel: 'Download Excel',
    scenesLabel: 'scenes',
    approveBreakdownButton: 'Approve',
    breakdownApprovedBadge: '✅ Script Breakdown Approved',
    breakdownFeedbackPlaceholder: 'What would you like changed? e.g. "Add the temple courtyard as a separate location" or "List the wedding saree under costumes too"',
    reviseBreakdownPlaceholder: 'What would you like changed about the breakdown?',
    reanalyzeButton: 'Re-analyze',
    reanalyzingLabel: 'Re-analyzing...',
    editButton: 'Edit',
    expandAllButton: 'Expand All',
    collapseAllButton: 'Collapse All',
    addItemButton: '+ Add Item',
    removeItemButton: 'Remove',
    saveChangesButton: 'Save Changes',
    savingChangesLabel: 'Saving...',
    cancelEditButton: 'Cancel',
    sceneCountLabel: 'Scene count',
    tentativeScheduleDateLabel: 'Tentative shoot start date',
    scheduleTargetDaysLabel: 'How many days should the schedule span?',
    scheduleSetupIntro: 'Before generating the shoot schedule, confirm a tentative start date and how many days you want the schedule to cover.',
    scheduleSpecialInstructionsLabel: 'Any specific way this schedule should happen? (optional)',
    scheduleSpecialInstructionsPlaceholder: 'e.g. "Shoot linearly by location. 5 days, 6am-11am each day, but the last day should be a full night shoot at the restaurant/pub."',
    waitingOnProductionManagerNotice: 'Waiting for the Production Manager to generate the shoot schedule.',
    waitingOnProductionManagerImportNotice: 'Waiting for the script to be imported and analyzed.',
    availabilityFormIntro: "Before building a shoot schedule, give a rough sense of when your major characters (artists) and locations are available. Mark anything you don't know yet as \"unknown\" — the schedule will just estimate.",
    characterAvailabilityHeading: 'Character (Artist) Availability',
    locationAvailabilityHeading: 'Location Availability',
    availableDatesPlaceholder: 'e.g. Available all of March, except weekends',
    unknownEstimateLabel: "Unknown — estimate for me",
    generateScheduleButton: 'Generate Shoot Schedule',
    generatingScheduleLabel: 'Building shoot schedule...',
    shootScheduleHeading: 'Shoot Schedule',
    shootDayLabel: 'Day',
    conflictsHeading: 'Flagged Conflicts',
    castCalledLabel: 'Cast Called',
    shootDayCompletedLabel: 'Completed',
    costumeLabel: 'Costume',
    propertiesLabel: 'Properties',
    adRemarkLabel: 'AD Remark',
    markDayShotButton: 'Mark Day as Shot',
    confirmShotScenesButton: 'Confirm Shot Scenes',
    completionNotePlaceholder: 'Uncheck any scene not actually completed, and add a note if useful (e.g. "rained in the afternoon, milkman scene needs a reshoot"). Unchecked scenes move to the next schedule automatically.',
    recordingShotDayLabel: 'Recording...',
    dayCompletionReportIntro: "Tell us what actually happened today, in your own words — refer to scenes by their real script scene numbers, just like on your paper sheet.",
    dayCompletionReportPlaceholder: 'e.g. "Completed Episode 1 scenes 1-6 and Episode 3 1A-1B. Could not get to the maid interviews (2A) or Episode 2 7-9 — pushed to another day."',
    interpretReportButton: 'Interpret Report',
    parsingDayCompletionLabel: 'Reading report...',
    interpretedAsHeading: "Here's what I understood — review before confirming:",
    completedLabel: 'Completed',
    movesToNextDayLabel: 'Not completed, moves to next day',
    noneLabel: 'none',
    reviewCheckboxesNote: 'The scene checkboxes above have been set to match this — adjust any of them by hand if something looks wrong before confirming.',
    artistScheduleHeading: 'Artist-Wise Summary',
    artistStatusWrappedLabel: 'Wrapped',
    artistStatusPendingLabel: 'Pending',
    artistStatusInProgressLabel: 'In Progress',
    totalDaysLabel: 'Total Days',
    approveScheduleButton: 'Approve',
    scheduleApprovedBadge: '✅ Shoot Schedule Approved',
    scheduleFeedbackPlaceholder: 'What would you like changed? e.g. "Group all the temple scenes together" or "Kamini is only available weekends, adjust around that"',
    generateCharacterSheetButton: 'Create Characters',
    generatingCharacterSheetLabel: 'Creating characters...',
    characterSheetHeading: 'Character Sheet',
    approveCharacterSheetButton: 'Approve',
    characterSheetApprovedBadge: '✅ Characters Approved',
    characterSheetFeedbackPlaceholder: 'What would you like changed? e.g. "Give the antagonist a stronger reason to believe he\'s right" or "Deepen the daughter\'s inner conflict"',
    archetypeLabel: 'Archetype',
    wantLabel: 'Want',
    needLabel: 'Need',
    flawLabel: 'Flaw',
    virtuesLabel: 'Virtues',
    innerConflictLabel: 'Inner Conflict',
    outerConflictLabel: 'Outer Conflict',
    arcLabel: 'Arc',
    introductionBeatLabel: 'Introduction Beat',
    heroLoglineLabel: "Their Own Story (as the hero of it)",
    archetypeLabels: {
      hero: 'Hero',
      mentor: 'Mentor',
      threshold_guardian: 'Threshold Guardian',
      herald: 'Herald',
      shapeshifter: 'Shapeshifter',
      shadow: 'Shadow',
      ally: 'Ally',
      trickster: 'Trickster',
    },
    generateBitSheet: 'Generate Bit Sheet',
    generatingBitSheet: 'Generating bit sheet...',
    bitSheetHeading: 'Bit Sheet (Plot Points)',
    approveBitSheetButton: 'Approve Bit Sheet',
    bitSheetApprovedBadge: '✅ Bit Sheet Approved',
    bitSheetFeedbackPlaceholder: 'What would you like changed? e.g. "Add a bit where she discovers the letter" or "The midpoint needs more stakes"',
    bitTypeLabels: {
      opening_image: 'Opening Image',
      theme_stated: 'Theme Stated',
      catalyst: 'Catalyst',
      reveal: 'Reveal',
      plot_point_1: 'Plot Point 1',
      midpoint: 'Midpoint',
      setback: 'Setback',
      all_is_lost: 'All Is Lost',
      plot_point_2: 'Plot Point 2',
      crisis: 'Crisis',
      climax: 'Climax',
      realization: 'Realization',
      turning_point: 'Turning Point',
      resolution_beat: 'Resolution Beat',
      final_image: 'Final Image',
    },
    scenePurposeLabels: {
      plot_advancing: 'Plot',
      character_revealing: 'Character',
    },
    sceneTurnLabel: 'Turn',
  },
  or: {
    heading: 'ଚଳଚ୍ଚିତ୍ର ନିର୍ମାଣ ଆପ୍',
    openMenuLabel: 'ମେନୁ ଖୋଲନ୍ତୁ',
    closeMenuLabel: 'ମେନୁ ବନ୍ଦ କରନ୍ତୁ',
    usernameLabel: 'ୟୁଜରନେମ୍',
    passwordLabel: 'ପାସୱାର୍ଡ',
    loginButton: 'ଲଗ୍ ଇନ୍',
    loggingInLabel: 'ଲଗ୍ ଇନ୍ ହେଉଛି…',
    logoutButton: 'ଲଗ୍ ଆଉଟ୍',
    manageUsersButton: 'ୟୁଜର୍ ପରିଚାଳନା',
    assignProjectPlaceholder: 'ପ୍ରୋଜେକ୍ଟକୁ ନ୍ୟସ୍ତ କରନ୍ତୁ…',
    roleAdmin: 'ଆଡମିନ୍',
    roleDirector: 'ଡିରେକ୍ଟର୍',
    roleProductionManager: 'ପ୍ରଡକ୍ସନ୍ ମ୍ୟାନେଜର୍',
    emptyGreeting: 'ଆପଣଙ୍କ ଧାରଣା ଲେଖନ୍ତୁ ଏବଂ ଅନୁସନ୍ଧାନ କରନ୍ତୁ',
    newIdeaButton: 'ନୂଆ ଧାରଣା',
    regeneratePlaceholder: '2 ନୂଆ ବିକଳ୍ପ ପାଇଁ Enter ଦବାନ୍ତୁ, କିମ୍ବା ମତାମତ ଲେଖନ୍ତୁ',
    lockedBadgeLabel: 'ବାଛି ନିଆଗଲା',
    sidebarHistoryLabel: 'ଇତିହାସ',
    sidebarHistoryNote: 'ଆପଣଙ୍କର ସେଭ୍ ହୋଇଥିବା ପ୍ରୋଜେକ୍ଟ — ଲୋଡ୍ କରିବାକୁ ଏକକୁ କ୍ଲିକ୍ କରନ୍ତୁ।',
    sidebarNewProject: 'ନୂଆ ପ୍ରୋଜେକ୍ଟ',
    renameProjectPrompt: 'ଏହି ପ୍ରୋଜେକ୍ଟର ନାମ ପରିବର୍ତ୍ତନ କରନ୍ତୁ',
    renameIconTitle: 'ପ୍ରୋଜେକ୍ଟ ନାମ ବଦଳାନ୍ତୁ',
    agentsSectionTitle: 'ଏଜେଣ୍ଟ',
    masterProjectListLabel: 'ସମସ୍ତ ପ୍ରୋଜେକ୍ଟ',
    storyAgentLabel: 'ଷ୍ଟୋରୀ ଏବଂ ସ୍କ୍ରିନପ୍ଲେ',
    productionAgentLabel: 'ପ୍ରଡକ୍ସନ୍ ମେନେଜମେଣ୍ଟ',
    masterProjectListHeading: 'ସମସ୍ତ ପ୍ରୋଜେକ୍ଟ',
    loadingLabel: 'ଲୋଡ୍ ହେଉଛି...',
    ongoingProjectsHeading: 'ଚାଲୁଥିବା / ପ୍ରି-ପ୍ରଡକ୍ସନ୍',
    inDevelopmentProjectsHeading: 'ବିକାଶ ଅଧୀନ',
    noProjectsInStageNote: 'ଏଠାରେ ଏପର୍ଯ୍ୟନ୍ତ କୌଣସି ପ୍ରୋଜେକ୍ଟ ନାହିଁ।',
    noOneAssignedNote: 'ଏପର୍ଯ୍ୟନ୍ତ କାହାକୁ ନ୍ୟୁକ୍ତ କରାଯାଇ ନାହିଁ',
    adRoleLabel: 'AD',
    directorRoleLabel: 'ଡିରେକ୍ଟର',
    newProductionButton: 'ନୂଆ ପ୍ରଡକ୍ସନ୍',
    importScreenplayIntro: 'ପ୍ରଡକ୍ସନ୍ ମେନେଜମେଣ୍ଟ ଏକ ସମ୍ପୂର୍ଣ୍ଣ ସ୍କ୍ରିନପ୍ଲେ ଠାରୁ କାମ କରେ — ଏହା ଏହି ଆପ୍ରେ ଲେଖା ହୋଇଥିବା ଆବଶ୍ୟକ ନାହିଁ।',
    uploadScreenplayFileButton: 'ସ୍କ୍ରିନପ୍ଲେ ଫାଇଲ୍ ଅପଲୋଡ୍ କରନ୍ତୁ',
    screenplayFileFormatsNote: 'Final Draft (.fdx), Scrite (.scrite), Word (.docx/.doc), PDF, ଏବଂ ପ୍ଲେନ୍ ଟେକ୍ସଟ୍ ସପୋର୍ଟ କରେ।',
    importScreenplayOrPaste: 'କିମ୍ବା ସିଧା ପେଷ୍ଟ କରନ୍ତୁ:',
    importScreenplayPlaceholder: 'ଆପଣଙ୍କ ସମ୍ପୂର୍ଣ୍ଣ ସ୍କ୍ରିନପ୍ଲେ ଏଠାରେ ପେଷ୍ଟ କରନ୍ତୁ…',
    importScreenplayButton: 'ସ୍କ୍ରିନପ୍ଲେ ଇମ୍ପୋର୍ଟ କରନ୍ତୁ',
    importingScreenplayLabel: 'ସ୍କ୍ରିନପ୍ଲେ ପଢ଼ାଯାଉଛି...',
    reimportScreenplayButton: 'ଅପଡେଟ୍ ହୋଇଥିବା ସ୍କ୍ରିନପ୍ଲେ ପୁନଃ ଅପଲୋଡ୍ କରନ୍ତୁ',
    reimportScreenplayIntro: 'ଲେଖକଙ୍କ ନୂଆ ଡ୍ରାଫ୍ଟ ତଳେ ପେଷ୍ଟ କରନ୍ତୁ। ଆପଣ ପୂର୍ବରୁ ଭରିଥିବା ସିନ୍ ନମ୍ବର, କାଷ୍ଟ, ଯୋଗାଯୋଗ ନମ୍ବର ଏବଂ ଫଟୋ ସୁରକ୍ଷିତ ରହିବ — କିଛି ଯୋଡାଗଲା କି କିଛି ମିଳିଲା ନାହିଁ ତାହାର ସାରାଂଶ ମିଳିବ।',
    reimportingScreenplayLabel: 'ଅପଡେଟ୍ ସ୍କ୍ରିନପ୍ଲେ ପୁନଃ ବିଶ୍ଳେଷଣ ହେଉଛି...',
    confirmReimportScreenplayButton: 'ସ୍କ୍ରିନପ୍ଲେ ଅପଡେଟ୍ କରନ୍ତୁ',
    reimportChangesHeading: 'ସ୍କ୍ରିନପ୍ଲେ ଅପଡେଟ୍ ହେଲା — ପରିବର୍ତ୍ତନ ମିଳିଲା:',
    reimportAddedScenesLabel: 'ନୂଆ ସିନ୍',
    reimportRemovedScenesLabel: 'ସ୍କ୍ରିପ୍ଟରେ ଆଉ ନାହିଁ ଥିବା ସିନ୍',
    reimportAddedCharactersLabel: 'ନୂଆ ଚରିତ୍ର',
    reimportRemovedCharactersLabel: 'ମିଳିନଥିବା ଚରିତ୍ର (କାଷ୍ଟ ସୂଚନା ସୁରକ୍ଷିତ ଅଛି — ଯଦି ସଠିକ୍ ତେବେ ହାତରେ ହଟାନ୍ତୁ)',
    reimportAddedLocationsLabel: 'ନୂଆ ସ୍ଥାନ',
    reimportRemovedLocationsLabel: 'ମିଳିନଥିବା ସ୍ଥାନ (ସୁରକ୍ଷିତ ଅଛି — ଯଦି ସଠିକ୍ ତେବେ ହାତରେ ହଟାନ୍ତୁ)',
    reimportShootScheduleWarning: 'ଏହି ପ୍ରୋଜେକ୍ଟ ପାଇଁ ଆପଣଙ୍କର ପୂର୍ବରୁ ଏକ ସୁଟିଂ ସିଡ୍ୟୁଲ୍ ଅଛି — ସିନ୍ ନମ୍ବର କିମ୍ବା କ୍ରମ ପରିବର୍ତ୍ତନ ହୋଇଥାଇପାରେ, ଏହାକୁ ପୁନଃ ତିଆରି କରନ୍ତୁ।',
    stageIdeaLabel: 'ଧାରଣା',
    stageSynopsisLabel: 'ସିନୋପ୍ସିସ୍',
    stageCharactersLabel: 'ଚରିତ୍ର',
    stageBitSheetLabel: 'ବିଟ୍ ସିଟ୍',
    stageScreenplayLabel: 'ସ୍କ୍ରିନପ୍ଲେ',
    stageProductionLabel: 'ପ୍ରଡକ୍ସନ୍',
    stageBreakdownLabel: 'ସ୍କ୍ରିପ୍ଟ ବ୍ରେକଡାଉନ୍',
    stageCrewLabel: 'କ୍ରୁ ଓ କାଷ୍ଟ',
    stageScheduleLabel: 'ସୁଟିଂ ସିଡ୍ୟୁଲ୍',
    crewHeading: 'କ୍ରୁ ଓ କାଷ୍ଟ',
    downloadAllCrewExcelLabel: 'ସମସ୍ତ କାଷ୍ଟ ଓ କ୍ରୁ ଡାଉନଲୋଡ୍ କରନ୍ତୁ (Excel)',
    castSectionHeading: 'କାଷ୍ଟ',
    artDepartmentHeading: 'ଆର୍ଟ ବିଭାଗ',
    costumeDepartmentHeading: 'ପୋଷାକ ବିଭାଗ',
    masterCrewHeading: 'ମାଷ୍ଟର କ୍ରୁ ତାଲିକା',
    crewNameLabel: 'ନାମ',
    crewRoleLabel: 'ଭୂମିକା / ପଦବୀ',
    crewContactLabel: 'ଯୋଗାଯୋଗ ନମ୍ବର',
    crewPhotoLabel: 'ଫଟୋ',
    crewCharacterLabel: 'ଚରିତ୍ର',
    addCrewMemberButton: 'ଯୋଡ଼ନ୍ତୁ',
    removeCrewMemberButton: 'ହଟାନ୍ତୁ',
    modifyCrewMemberButton: 'ପରିବର୍ତ୍ତନ କରନ୍ତୁ',
    noCrewMembersYet: 'ଏପର୍ଯ୍ୟନ୍ତ କେହି ଯୋଡ଼ାଯାଇ ନାହାନ୍ତି।',
    allCharactersCastNotice: 'ସମସ୍ତ ଚରିତ୍ର କାଷ୍ଟ ହୋଇସାରିଛି।',
    castingActorNamePlaceholder: 'ଏହି ଚରିତ୍ର ଭୂମିକାରେ ଅଭିନେତା',
    locationConfirmedNamePlaceholder: 'ନିଶ୍ଚିତ ସ୍ଥାନ ନାମ / ଠିକଣା',
    awaitingFormatPlaceholder: 'ଆପଣଙ୍କ ପିଚ୍ ଡେକ୍ ତିଆରି ହେଉଛି…',
    revisePitchDeckPlaceholder: 'ପିଚ୍ ଡେକ୍ ପାଇଁ ପରିବର୍ତ୍ତନ ଲେଖନ୍ତୁ, ତାପରେ Enter ଦବାନ୍ତୁ…',
    reviseCharacterSheetPlaceholder: 'ଚରିତ୍ର ପାଇଁ ପରିବର୍ତ୍ତନ ଲେଖନ୍ତୁ, ତାପରେ Enter ଦବାନ୍ତୁ…',
    reviseThreeActPlaceholder: 'ତ୍ରି-ଅଙ୍କ ଗଠନ ପାଇଁ ପରିବର୍ତ୍ତନ ଲେଖନ୍ତୁ, ତାପରେ Enter ଦବାନ୍ତୁ…',
    reviseBitSheetPlaceholder: 'ବିଟ୍ ସିଟ୍ ପାଇଁ ପରିବର୍ତ୍ତନ ଲେଖନ୍ତୁ, ତାପରେ Enter ଦବାନ୍ତୁ…',
    reviseSceneListPlaceholder: 'ସିନ୍ ଲିଷ୍ଟ ପାଇଁ ପରିବର୍ତ୍ତନ ଲେଖନ୍ତୁ, ତାପରେ Enter ଦବାନ୍ତୁ…',
    reviseSchedulePlaceholder: 'ସୁଟିଂ ସିଡ୍ୟୁଲ୍ ପାଇଁ ପରିବର୍ତ୍ତନ ଲେଖନ୍ତୁ, ତାପରେ Enter ଦବାନ୍ତୁ…',
    idlePlaceholder: 'ବର୍ତ୍ତମାନ ପରିବର୍ତ୍ତନ କରିବାକୁ କିଛି ନାହିଁ — ଉପରର ବଟନ୍ ବ୍ୟବହାର କରନ୍ତୁ',
    changesChatToggleLabel: 'ପରିବର୍ତ୍ତନ ପାଇଁ ପଚାରନ୍ତୁ',
    changesChatHeading: 'ପରିବର୍ତ୍ତନ',
    changesChatEmptyNote: 'ତଳେ ଏକ ପରିବର୍ତ୍ତନ ଲେଖନ୍ତୁ, ଏହା ଏଠାରେ ଦେଖାଯିବ, ସହିତ କଣ ହେଲା ତାହା ମଧ୍ୟ।',
    changesChatAppliedMessage: '✅ ହୋଇଗଲା — ପ୍ରୟୋଗ ଏବଂ ପୁନଃତିଆରି ହୋଇଗଲା।',
    changesChatErrorMessage: '⚠️ କିଛି ଭୁଲ ହେଲା — ପୁଣି ଚେଷ୍ଟା କରନ୍ତୁ।',
    exportButtonLabel: 'ପ୍ରୋଜେକ୍ଟ ସେଭ୍ କରନ୍ତୁ',
    exportingProjectLabel: 'ସେଭ୍ ହେଉଛି…',
    connectGoogleContactsButton: 'Google ଯୋଗାଯୋଗ ସଂଯୋଗ କରନ୍ତୁ',
    googleContactsConnectedLabel: '✅ Google Contacts ସଂଯୁକ୍ତ',
    googleContactsConnectedNotice: 'Google Contacts ସଂଯୁକ୍ତ ହୋଇଗଲା।',
    googleContactsErrorNotice: 'Google Contacts ସଂଯୋଗ ହୋଇପାରିଲା ନାହିଁ। ପୁଣି ଚେଷ୍ଟା କରନ୍ତୁ।',
    pickFromContactsButton: 'Google Contacts ରୁ ବାଛନ୍ତୁ',
    downloadAuditionSidesButton: 'କାରାକ୍ଟର ସ୍କ୍ରିପ୍ଟ ଡାଉନଲୋଡ୍ କରନ୍ତୁ (PDF)',
    auditionSidesHint: 'ଏହି ଚରିତ୍ର ଥିବା ପ୍ରତ୍ୟେକ ଦୃଶ୍ୟ, ସ୍କ୍ରିପ୍ଟରୁ ତାଙ୍କ ପ୍ରକୃତ ସଂଳାପ ସହିତ — କିମ୍ବା ସେ କଥା ନ କହିଥିବା ଦୃଶ୍ୟରେ ତାଙ୍କ କାର୍ଯ୍ୟର ବର୍ଣ୍ଣନା — ଯାହା ଦ୍ୱାରା ଆପଣ ଅଭିନେତାଙ୍କୁ ଏକ ସେଲ୍ଫ-ଟେପ୍ ଅଡିସନ୍ ପାଇଁ ସମ୍ପୂର୍ଣ୍ଣ ପ୍ୟାକେଟ୍ ପଠାଇ ପାରିବେ।',
    sendWhatsAppButton: 'WhatsApp ରେ ପଠାନ୍ତୁ',
    sendingWhatsAppLabel: 'ପ୍ରସ୍ତୁତ ହେଉଛି…',
    invalidPhoneNumberNotice: 'ଏହି ଯୋଗାଯୋଗ ନମ୍ବର WhatsApp ପାଇଁ ବୈଧ ମନେହେଉନାହିଁ।',
    whatsAppShareLinkErrorNotice: 'WhatsApp ଲିଙ୍କ ତିଆରି ହୋଇପାରିଲା ନାହିଁ। ପୁଣି ଚେଷ୍ଟା କରନ୍ତୁ।',
    searchContactsPlaceholder: 'ଯୋଗାଯୋଗ ଖୋଜନ୍ତୁ…',
    loadingContactsLabel: 'ଯୋଗାଯୋଗ ଲୋଡ୍ ହେଉଛି…',
    noContactsFound: 'କୌଣସି ମେଳ ଖାଉଥିବା ଯୋଗାଯୋଗ ନାହିଁ।',
    importButtonLabel: 'ପ୍ରୋଜେକ୍ଟ ଇମ୍ପୋର୍ଟ କରନ୍ତୁ',
    importInvalidFile: 'ଏହା ଏକ ବୈଧ ଏକ୍ସପୋର୍ଟ ହୋଇଥିବା ପ୍ରୋଜେକ୍ଟ ଫାଇଲ ପରି ଦେଖାଯାଉ ନାହିଁ।',
    pinIconTitle: 'ପ୍ରୋଜେକ୍ଟ ପିନ୍ କରନ୍ତୁ',
    unpinIconTitle: 'ପିନ୍ ହଟାନ୍ତୁ',
    deleteIconTitle: 'ପ୍ରୋଜେକ୍ଟ ଡିଲିଟ୍ କରନ୍ତୁ',
    deleteProjectConfirm: 'ଏହି ପ୍ରୋଜେକ୍ଟକୁ ଡିଲିଟ୍ କରିବେ? ଏହା ପୁନଃ ପାଇ ହେବ ନାହିଁ।',
    startStageLabel: 'ଆରମ୍ଭ କରନ୍ତୁ:',
    startStageIdea: 'ଧାରଣା',
    startStageSynopsis: 'ସିନୋପ୍ସିସ୍',
    startStageBitSheet: 'ବିଟ୍ ସିଟ୍',
    startStageSceneList: 'ସିନ୍ ଲିଷ୍ଟ',
    skipPastePlaceholderSynopsis: 'ଆପଣଙ୍କ ସିନୋପ୍ସିସ୍ କିମ୍ବା ପିଚ୍ ଟେକ୍ସଟ୍ ଏଠାରେ ପେଷ୍ଟ କରନ୍ତୁ…',
    skipPastePlaceholderBitSheet: 'ଆପଣଙ୍କ ବିଟ୍ ସିଟ୍ (ପ୍ଲଟ୍ ପଏଣ୍ଟ) ଟେକ୍ସଟ୍ ଏଠାରେ ପେଷ୍ଟ କରନ୍ତୁ…',
    skipPastePlaceholderSceneList: 'ଆପଣଙ୍କ ସିନ୍-ବାଏ-ସିନ୍ ୱାନ୍-ଲାଇନର୍ ଏଠାରେ ପେଷ୍ଟ କରନ୍ତୁ…',
    skipRuntimeLabel: 'ପ୍ରାୟ ମୋଟ ରନଟାଇମ୍ (ମିନିଟ୍)',
    skipContinueButton: 'ଆଗକୁ ବଢ଼ନ୍ତୁ',
    skipContinueButtonLoading: 'କାମ ଚାଲୁଛି…',
    skipQuotaNote: 'ଏହା ପୂର୍ବ ପର୍ଯ୍ୟାୟଗୁଡ଼ିକୁ ସ୍ୱୟଂଚାଳିତ ଭାବରେ ତାଲମେଳ ରଖି ତିଆରି କରିବ, ତେଣୁ ବାକି ଆପ୍ ସାଧାରଣ ଭାବରେ କାମ କରେ — ଏହା ଅଳ୍ପ ଅଧିକ AI କଲ୍ ଖର୍ଚ୍ଚ କରେ (ଦୈନିକ ଫ୍ରି-ଟିଅର୍ ସୀମା ଦୃଷ୍ଟିରୁ ଜାଣିବା ଜରୁରୀ)। ବର୍ତ୍ତମାନ ପାଇଁ କେବଳ ଫିଲ୍ମ୍।',
    instruction: 'ତଳେ ଆପଣଙ୍କ ଚଳଚ୍ଚିତ୍ର ଧାରଣା ଲେଖି "Generate" କ୍ଲିକ୍ କରନ୍ତୁ।',
    placeholder: 'ଉଦାହରଣ: ଓଡ଼ିଶାର ଏକ ମାଛଧରା ପୁଣୁଅଁ ପୂର୍ଣ୍ଣିମାରେ ଖାଲି ଫେରୁଥିବା ଡଙ୍ଗାର ରହସ୍ୟ ଆବିଷ୍କାର କରନ୍ତି...',
    generate: 'ଜେନେରେଟ୍',
    generating: 'ଜେନେରେଟ୍ ହେଉଛି...',
    storylineSuggestions: 'କାହାଣୀ ପ୍ରସ୍ତାବ:',
    optionLabel: (n) => `ବିକଳ୍ପ ${n}`,
    chooseThisOne: 'ଏହାକୁ ବାଛନ୍ତୁ',
    formatQuestion: 'ଏହା ଏକ ଚଳଚ୍ଚିତ୍ର ଅଥବା ୱେବ ସିରିଜ୍?',
    filmOption: 'ଚଳଚ୍ଚିତ୍ର',
    seriesOption: 'ୱେବ ସିରିଜ୍',
    episodeCountLabel: 'ପର୍ବ ସଂଖ୍ୟା',
    episodeMinutesLabel: 'ପ୍ରତି ପର୍ବ ମିନିଟ୍',
    runtimeMinutesLabel: 'ସମୁଦାୟ ଅବଧି (ମିନିଟ୍)',
    buildPitchDeck: 'ପିଚ୍ ଡେକ୍ ତିଆରି କରନ୍ତୁ',
    buildingPitchDeck: 'ପିଚ୍ ଡେକ୍ ତିଆରି ହେଉଛି...',
    cancel: 'ବାତିଲ୍',
    premise: 'ପ୍ରସଙ୍ଗ',
    toneGenre: 'ଶୈଳୀ / ଧାରା',
    targetAudience: 'ଲକ୍ଷ୍ୟ ଦର୍ଶକ',
    majorCharactersHeading: 'ମୁଖ୍ୟ ଚରିତ୍ର',
    emotionalCoreLabel: 'ଭାବନାତ୍ମକ ମୂଳ',
    conflictLabel: 'ସଂଘର୍ଷ',
    exportAsPdf: 'PDF ପ୍ରେଜେଣ୍ଟେଶନ୍ ଏକ୍ସପୋର୍ଟ କରନ୍ତୁ',
    formatFilm: 'ପୂର୍ଣ୍ଣ ଚଳଚ୍ଚିତ୍ର',
    formatSeries: (count, minutes) => `ୱେବ ସିରିଜ୍ · ${count} ପର୍ବ × ${minutes} ମିନିଟ୍ ପ୍ରତି`,
    episodeBreakdown: 'ପର୍ବ ବିବରଣୀ',
    episodeLabel: 'ପର୍ବ',
    genericError: 'କିଛି ଭୁଲ ହେଲା। ଦୟାକରି ଅଳ୍ପ ସମୟ ଅପେକ୍ଷା କରି ପୁନଃ ଚେଷ୍ଟା କରନ୍ତୁ।',
    missingCharacterNamePlaceholder: 'ଏକ ଚରିତ୍ର ଛାଡ଼ିଗଲା କି? ତାହାର ନାମ ଲେଖନ୍ତୁ…',
    addMissingCharacterButton: 'ଚରିତ୍ର ଯୋଡ଼ନ୍ତୁ',
    addingCharacterLabel: 'ଯୋଡ଼ୁଛି…',
    ageLabel: 'ବୟସ',
    genderMaleLabel: 'ପୁରୁଷ',
    genderFemaleLabel: 'ମହିଳା',
    unspecifiedLabel: 'ଅନିର୍ଦ୍ଦିଷ୍ଟ',
    directorOverviewHeading: 'ପ୍ରଡକ୍ସନ୍ ସ୍ଥିତି ସମୀକ୍ଷା',
    directorOverviewCastLabel: 'କାଷ୍ଟ',
    directorOverviewLocationsLabel: 'ଲୋକେସନ୍',
    directorOverviewCrewLabel: 'କ୍ରୁ',
    directorOverviewScenesLabel: 'ସୁଟିଂ ପ୍ରଗତି',
    directorOverviewAllCastFinalized: 'ସମସ୍ତ ଚରିତ୍ର କାଷ୍ଟ ହୋଇସାରିଛି — କିଛି ବାକି ନାହିଁ।',
    directorOverviewPendingCastNote: 'ଏହି ଚରିତ୍ରଗୁଡ଼ିକ ଏପର୍ଯ୍ୟନ୍ତ କାଷ୍ଟ ହୋଇନାହିଁ:',
    directorOverviewAllLocationsFinalized: 'ସମସ୍ତ ଲୋକେସନ୍ କନଫର୍ମ ହୋଇସାରିଛି — କିଛି ବାକି ନାହିଁ।',
    directorOverviewPendingLocationsNote: 'ଏହି ଲୋକେସନ୍ ଏପର୍ଯ୍ୟନ୍ତ କନଫର୍ମ ହୋଇନାହିଁ:',
    directorOverviewNoCrewNote: 'ଏପର୍ଯ୍ୟନ୍ତ କୌଣସି କ୍ରୁ ମେମ୍ବର ଯୋଡ଼ା ହୋଇନାହିଁ।',
    shotLabel: 'ସୁଟ୍ ହୋଇଗଲା',
    pendingLabel: 'ବାକି',
    showDetailsButton: 'ଦୃଶ୍ୟ-ଅନୁସାରେ ବିବରଣୀ ଦେଖାନ୍ତୁ',
    hideDetailsButton: 'ଦୃଶ୍ୟ-ଅନୁସାରେ ବିବରଣୀ ଲୁଚାନ୍ତୁ',
    loadingOverviewLabel: 'ପ୍ରଡକ୍ସନ୍ ସ୍ଥିତି ଲୋଡ୍ ହେଉଛି…',
    findMissingCharactersButton: 'ମିଳିନଥିବା ଚରିତ୍ର ପାଇଁ ପୁନଃ ବିଶ୍ଳେଷଣ କରନ୍ତୁ',
    findingMissingCharactersLabel: 'ସ୍କ୍ରିପ୍ଟ ସ୍କାନ୍ ହେଉଛି...',
    findMissingCharactersHint: 'ସମ୍ପୂର୍ଣ୍ଣ ସ୍କ୍ରିପ୍ଟକୁ ପୁଙ୍ଖାନୁପୁଙ୍ଖ ଭାବରେ ପୁନଃ ସ୍କାନ୍ କରି ଏହି ତାଲିକାରେ ନଥିବା କୌଣସି ଚରିତ୍ର (ନିରବ ଚରିତ୍ର ସହିତ) ଥିଲେ ଯୋଡ଼ିଥାଏ। ପୂର୍ବରୁ ଥିବା ଏଣ୍ଟ୍ରି କେବେ ହଟାଏ ନାହିଁ କି ପରିବର୍ତ୍ତନ କରେ ନାହିଁ। ଅଜଣା ଏକ୍ସଟ୍ରା/ଜନତାକୁ ବାଦ୍ ଦିଏ।',
    foundMissingCharactersLabel: 'ମିଳିଲା ଏବଂ ଯୋଡ଼ାଗଲା',
    noMissingCharactersFoundLabel: 'କୌଣସି ମିଳିନଥିବା ଚରିତ୍ର ମିଳିଲା ନାହିଁ — କାଷ୍ଟ ତାଲିକା ଆଗରୁ ସମସ୍ତଙ୍କୁ ଅନ୍ତର୍ଭୁକ୍ତ କରିଥାଏ।',
    approveButton: 'ଅନୁମୋଦନ କରନ୍ତୁ',
    requestChangesButton: 'ପରିବର୍ତ୍ତନ ପାଇଁ ଅନୁରୋଧ',
    approvedBadge: '✅ ଅନୁମୋଦିତ',
    changesRequestedBadge: 'ମତାମତ ପରେ ସଂଶୋଧିତ:',
    feedbackPlaceholder: 'ଆପଣ କଣ ପରିବର୍ତ୍ତନ ଚାହୁଁଛନ୍ତି? ଉଦା: "ଶୈଳୀକୁ ଅଧିକ ଗମ୍ଭୀର କରନ୍ତୁ"',
    submitFeedback: 'ମତାମତ ଦାଖଲ କରି ପୁନଃ ତିଆରି କରନ୍ତୁ',
    submittingFeedback: 'ପୁନଃ ତିଆରି ହେଉଛି...',
    generateThreeAct: 'ତ୍ରି-ଅଙ୍କ ସଂରଚନା ତିଆରି କରନ୍ତୁ',
    generatingThreeAct: 'ତ୍ରି-ଅଙ୍କ ସଂରଚନା ତିଆରି ହେଉଛି...',
    threeActHeading: 'ତ୍ରି-ଅଙ୍କ ସଂରଚନା',
    controllingIdeaLabel: 'ମୂଳ ଭାବ:',
    setupLabel: 'ପ୍ରଥମ ଅଙ୍କ: ପ୍ରସ୍ଥାପନା',
    confrontationLabel: 'ଦ୍ୱିତୀୟ ଅଙ୍କ: ସଂଘର୍ଷ',
    resolutionLabel: 'ତୃତୀୟ ଅଙ୍କ: ସମାଧାନ',
    lockButton: 'ସଂରଚନା ଲକ୍ କରନ୍ତୁ',
    lockedBadge: '🔒 ଲକ୍ ହୋଇଛି',
    structureFeedbackPlaceholder: 'ଆପଣ କଣ ପରିବର୍ତ୍ତନ ଚାହୁଁଛନ୍ତି? ଉଦା: "ଦ୍ୱିତୀୟ ଅଙ୍କରେ ଏକ ମୋଡ଼ ଯୋଡ଼ନ୍ତୁ"',
    versionHistoryHeading: 'ସଂସ୍କରଣ ଇତିହାସ',
    versionLabel: 'ସଂସ୍କରଣ',
    statusPending: 'ବିଚାରାଧୀନ',
    statusLocked: 'ଲକ୍ ହୋଇଛି',
    statusChangesRequested: 'ପରିବର୍ତ୍ତନ ଅନୁରୋଧିତ',
    viewButton: 'ଦେଖନ୍ତୁ',
    hideButton: 'ଛପାନ୍ତୁ',
    feedbackGivenLabel: 'ମତାମତ:',
    episodeStructuresHeading: 'ପର୍ବ-ଅନୁସାରେ ତ୍ରି-ଅଙ୍କ ବିବରଣୀ',
    generateSceneList: 'ଦୃଶ୍ୟ ତାଲିକା ତିଆରି କରନ୍ତୁ',
    generatingSceneList: 'ଦୃଶ୍ୟ ତାଲିକା ତିଆରି ହେଉଛି...',
    sceneListHeading: 'ଦୃଶ୍ୟ-ଅନୁସାରେ ବିବରଣୀ',
    sceneLabel: 'ଦୃଶ୍ୟ',
    dayLabel: 'ଦିନ',
    nightLabel: 'ରାତି',
    approveSceneListButton: 'ଦୃଶ୍ୟ ତାଲିକା ଅନୁମୋଦନ କରନ୍ତୁ',
    sceneListApprovedBadge: '✅ ଦୃଶ୍ୟ ତାଲିକା ଅନୁମୋଦିତ',
    sceneListFeedbackPlaceholder: 'ଆପଣ କଣ ପରିବର୍ତ୍ତନ ଚାହୁଁଛନ୍ତି?',
    approxMinutesUnit: (minutes) => `~${minutes} ମିନିଟ୍`,
    totalRuntimeLabel: (total, target) => `ଆକଳିତ ସମୁଦାୟ: ${total} ମିନିଟ୍ (ଲକ୍ଷ୍ୟ: ${target} ମିନିଟ୍)`,
    runtimeMismatchNote: 'ଏହା ଲକ୍ଷ୍ୟ ଅବଧିଠାରୁ ଭିନ୍ନ ଅଛି — ତଳେ "ପରିବର୍ତ୍ତନ ପାଇଁ ଅନୁରୋଧ" ବ୍ୟବହାର କରନ୍ତୁ।',
    writeSceneButton: 'ଏହି ଦୃଶ୍ୟ ଲେଖନ୍ତୁ',
    generatingScreenplayScene: 'ଦୃଶ୍ୟ ଲେଖାଯାଉଛି...',
    screenplayFeedbackPlaceholder: 'ଆପଣ ଏହି ଦୃଶ୍ୟରେ କଣ ପରିବର୍ତ୍ତନ ଚାହୁଁଛନ୍ତି?',
    screenplayCompleteBanner: '🎬 ସମ୍ପୂର୍ଣ୍ଣ ସ୍କ୍ରିନପ୍ଲେ ତିଆରି ହୋଇଗଲା! ଏହି ଲକ୍ ହୋଇଥିବା ସଂରଚନା ଏବଂ ଅନ୍ତିମ ସ୍କ୍ରିନପ୍ଲେ ପରବର୍ତ୍ତୀ ପର୍ଯ୍ୟାୟକୁ ହସ୍ତାନ୍ତର ପାଇଁ ପ୍ରସ୍ତୁତ।',
    screenplayProgressLabel: (drafted, total) => `ସ୍କ୍ରିନପ୍ଲେ ପ୍ରଗତି: ${drafted} / ${total} ଦୃଶ୍ୟ ଲେଖାଯାଇଛି`,
    productionHeading: 'ପ୍ରଡକ୍ସନ୍ ମେନେଜମେଣ୍ଟ',
    scriptBreakdownHeading: 'ସ୍କ୍ରିପ୍ଟ ବ୍ରେକଡାଉନ୍',
    generateBreakdownButton: 'ସ୍କ୍ରିପ୍ଟ ବିଶ୍ଳେଷଣ କରନ୍ତୁ',
    generatingBreakdownLabel: 'ସ୍କ୍ରିପ୍ଟ ବିଶ୍ଳେଷଣ ହେଉଛି...',
    generateAdSheetButton: 'AD ସିନ୍ ବ୍ରେକଡାଉନ୍ ସିଟ୍ ତିଆରି କରନ୍ତୁ',
    generatingAdSheetLabel: 'AD ସିଟ୍ ତିଆରି ହେଉଛି...',
    downloadAdSheetLabel: 'AD ସିନ୍ ବ୍ରେକଡାଉନ୍ ସିଟ୍ ଡାଉନଲୋଡ୍ କରନ୍ତୁ (PDF)',
    artistListHeading: 'କଳାକାର ତାଲିକା',
    locationListHeading: 'ସ୍ଥାନ ତାଲିକା',
    propsHeading: 'ସାମଗ୍ରୀ ତାଲିକା (ପ୍ରପ୍ସ)',
    costumesHeading: 'ପୋଷାକ ପରିବର୍ତ୍ତନ',
    artHeading: 'କଳା ବିଭାଗ ମନ୍ତବ୍ୟ',
    downloadPdfLabel: 'PDF ଡାଉନଲୋଡ୍ କରନ୍ତୁ',
    downloadExcelLabel: 'Excel ଡାଉନଲୋଡ୍ କରନ୍ତୁ',
    scenesLabel: 'ଦୃଶ୍ୟ',
    approveBreakdownButton: 'ଅନୁମୋଦନ କରନ୍ତୁ',
    breakdownApprovedBadge: '✅ ସ୍କ୍ରିପ୍ଟ ବ୍ରେକଡାଉନ୍ ଅନୁମୋଦିତ',
    breakdownFeedbackPlaceholder: 'ଆପଣ କଣ ପରିବର୍ତ୍ତନ ଚାହୁଁଛନ୍ତି?',
    reviseBreakdownPlaceholder: 'ବ୍ରେକଡାଉନ୍‌ରେ କଣ ପରିବର୍ତ୍ତନ ଚାହାଁନ୍ତି?',
    reanalyzeButton: 'ପୁନଃ ବିଶ୍ଳେଷଣ',
    reanalyzingLabel: 'ପୁନଃ ବିଶ୍ଳେଷଣ ହେଉଛି...',
    editButton: 'ସମ୍ପାଦନା',
    expandAllButton: 'ସବୁ ଖୋଲନ୍ତୁ',
    collapseAllButton: 'ସବୁ ବନ୍ଦ କରନ୍ତୁ',
    addItemButton: '+ ଆଇଟମ୍ ଯୋଡ଼ନ୍ତୁ',
    removeItemButton: 'ହଟାନ୍ତୁ',
    saveChangesButton: 'ପରିବର୍ତ୍ତନ ସେଭ୍ କରନ୍ତୁ',
    savingChangesLabel: 'ସେଭ୍ ହେଉଛି...',
    cancelEditButton: 'ବାତିଲ୍',
    sceneCountLabel: 'ଦୃଶ୍ୟ ସଂଖ୍ୟା',
    tentativeScheduleDateLabel: 'ଆନୁମାନିକ ସୁଟିଂ ଆରମ୍ଭ ତାରିଖ',
    scheduleTargetDaysLabel: 'ସିଡ୍ୟୁଲ୍ କେତେ ଦିନ ପାଇଁ ହେବା ଉଚିତ?',
    scheduleSetupIntro: 'ସୁଟିଂ ସିଡ୍ୟୁଲ୍ ତିଆରି କରିବା ପୂର୍ବରୁ, ଏକ ଆନୁମାନିକ ଆରମ୍ଭ ତାରିଖ ଏବଂ ସିଡ୍ୟୁଲ୍ କେତେ ଦିନ ପାଇଁ ହେବା ଉଚିତ ତାହା ନିଶ୍ଚିତ କରନ୍ତୁ।',
    scheduleSpecialInstructionsLabel: 'ଏହି ସିଡ୍ୟୁଲ୍ କୌଣସି ନିର୍ଦ୍ଦିଷ୍ଟ ଢଙ୍ଗରେ ହେବା ଉଚିତ କି? (ଇଚ୍ଛାଧୀନ)',
    scheduleSpecialInstructionsPlaceholder: 'ଉଦାହରଣ: "ସ୍ଥାନ ଅନୁଯାୟୀ ଲିନିଅର୍ ଭାବରେ ସୁଟ୍ କରନ୍ତୁ। ୫ ଦିନ, ପ୍ରତିଦିନ ସକାଳ ୬ ଟାରୁ ୧୧ ଟା, କିନ୍ତୁ ଶେଷ ଦିନ ରେଷ୍ଟୁରାଣ୍ଟ/ପବ୍‌ରେ ପୂର୍ଣ୍ଣ ରାତି ସୁଟ୍ ହେବ।"',
    waitingOnProductionManagerNotice: 'ପ୍ରଡକ୍ସନ୍ ମ୍ୟାନେଜର୍ ସୁଟିଂ ସିଡ୍ୟୁଲ୍ ତିଆରି କରିବା ପାଇଁ ଅପେକ୍ଷାରେ।',
    waitingOnProductionManagerImportNotice: 'ସ୍କ୍ରିପ୍ଟ ଇମ୍ପୋର୍ଟ ଏବଂ ବିଶ୍ଳେଷଣ ପାଇଁ ଅପେକ୍ଷାରେ।',
    availabilityFormIntro: 'ସୁଟିଂ ସିଡ୍ୟୁଲ୍ ତିଆରି କରିବା ପୂର୍ବରୁ, ଆପଣଙ୍କ ମୁଖ୍ୟ ଚରିତ୍ର (କଳାକାର) ଏବଂ ସ୍ଥାନଗୁଡ଼ିକ କେବେ ଉପଲବ୍ଧ ତାହା ମୋଟାମୋଟି ଭାବେ ଜଣାନ୍ତୁ। ଯାହା ଜାଣି ନାହାନ୍ତି ତାହାକୁ "ଅଜଣା" ଚିହ୍ନିତ କରନ୍ତୁ — ସିଡ୍ୟୁଲ୍ ନିଜେ ଆକଳନ କରିବ।',
    characterAvailabilityHeading: 'ଚରିତ୍ର (କଳାକାର) ଉପଲବ୍ଧତା',
    locationAvailabilityHeading: 'ସ୍ଥାନ ଉପଲବ୍ଧତା',
    availableDatesPlaceholder: 'ଉଦାହରଣ: ମାର୍ଚ୍ଚ ମାସ ସାରା ଉପଲବ୍ଧ, ସପ୍ତାହ ଶେଷ ବ୍ୟତୀତ',
    unknownEstimateLabel: 'ଅଜଣା — ମୋ ପାଇଁ ଆକଳନ କରନ୍ତୁ',
    generateScheduleButton: 'ସୁଟିଂ ସିଡ୍ୟୁଲ୍ ତିଆରି କରନ୍ତୁ',
    generatingScheduleLabel: 'ସୁଟିଂ ସିଡ୍ୟୁଲ୍ ତିଆରି ହେଉଛି...',
    shootScheduleHeading: 'ସୁଟିଂ ସିଡ୍ୟୁଲ୍',
    shootDayLabel: 'ଦିନ',
    conflictsHeading: 'ଚିହ୍ନିତ ସମସ୍ୟା',
    castCalledLabel: 'କଳାକାର ଡକରା',
    shootDayCompletedLabel: 'ସମାପ୍ତ',
    costumeLabel: 'ପୋଷାକ',
    propertiesLabel: 'ପ୍ରପର୍ଟି',
    adRemarkLabel: 'AD ମନ୍ତବ୍ୟ',
    markDayShotButton: 'ଦିନଟି ସୁଟ୍ ହେଲା ବୋଲି ଚିହ୍ନଟ କରନ୍ତୁ',
    confirmShotScenesButton: 'ସୁଟ୍ ହୋଇଥିବା ସିନ୍ ନିଶ୍ଚିତ କରନ୍ତୁ',
    completionNotePlaceholder: 'ପ୍ରକୃତରେ ସମାପ୍ତ ହୋଇନଥିବା ଯେକୌଣସି ସିନ୍‌ର ଚେକ୍‌ବକ୍ସ ହଟାନ୍ତୁ, ଏବଂ ଉପଯୋଗୀ ହେଲେ ଏକ ମନ୍ତବ୍ୟ ଯୋଡ଼ନ୍ତୁ। ଅନ୍‌ଚେକ୍ ହୋଇଥିବା ସିନ୍ ପରବର୍ତ୍ତୀ ସିଡ୍ୟୁଲ୍‌କୁ ସ୍ୱଚାଳିତ ଭାବରେ ଯାଇଥାଏ।',
    recordingShotDayLabel: 'ରେକର୍ଡ ହେଉଛି...',
    dayCompletionReportIntro: 'ଆଜି ପ୍ରକୃତରେ କଣ ହେଲା ତାହା ନିଜ ଭାଷାରେ କୁହନ୍ତୁ — ସ୍କ୍ରିପ୍ଟର ପ୍ରକୃତ ସିନ୍ ନମ୍ବର ଅନୁଯାୟୀ ଉଲ୍ଲେଖ କରନ୍ତୁ, ଠିକ୍ ଆପଣଙ୍କ କାଗଜ ସିଟ୍ ପରି।',
    dayCompletionReportPlaceholder: 'ଉଦାହରଣ: "ଏପିସୋଡ୍ ୧ ର ସିନ୍ ୧-୬ ଏବଂ ଏପିସୋଡ୍ ୩ ର 1A-1B ସମାପ୍ତ ହେଲା। କାମବାଳୀ ସାକ୍ଷାତକାର (2A) କିମ୍ବା ଏପିସୋଡ୍ ୨ ର ୭-୯ ହୋଇପାରିଲା ନାହିଁ — ଅନ୍ୟ ଏକ ଦିନକୁ ଠେଲି ଦିଆଗଲା।"',
    interpretReportButton: 'ରିପୋର୍ଟ ବୁଝନ୍ତୁ',
    parsingDayCompletionLabel: 'ରିପୋର୍ଟ ପଢ଼ାଯାଉଛି...',
    interpretedAsHeading: 'ମୁଁ ଏହା ବୁଝିଲି — ନିଶ୍ଚିତ କରିବା ପୂର୍ବରୁ ସମୀକ୍ଷା କରନ୍ତୁ:',
    completedLabel: 'ସମାପ୍ତ',
    movesToNextDayLabel: 'ସମାପ୍ତ ହୋଇନାହିଁ, ପରବର୍ତ୍ତୀ ଦିନକୁ ଯାଉଛି',
    noneLabel: 'କିଛି ନାହିଁ',
    reviewCheckboxesNote: 'ଉପରର ସିନ୍ ଚେକ୍‌ବକ୍ସଗୁଡ଼ିକ ଏହା ସହିତ ମେଳ ଖାଉଥିବା ଭାବରେ ସେଟ୍ ହୋଇଛି — ନିଶ୍ଚିତ କରିବା ପୂର୍ବରୁ କିଛି ଭୁଲ ଲାଗିଲେ ହାତରେ ପରିବର୍ତ୍ତନ କରନ୍ତୁ।',
    artistScheduleHeading: 'କଳାକାର-ଅନୁଯାୟୀ ସାରାଂଶ',
    artistStatusWrappedLabel: 'ସମାପ୍ତ',
    artistStatusPendingLabel: 'ବାକି',
    artistStatusInProgressLabel: 'ଚାଲୁଛି',
    totalDaysLabel: 'ମୋଟ ଦିନ',
    approveScheduleButton: 'ଅନୁମୋଦନ କରନ୍ତୁ',
    scheduleApprovedBadge: '✅ ସୁଟିଂ ସିଡ୍ୟୁଲ୍ ଅନୁମୋଦିତ',
    scheduleFeedbackPlaceholder: 'ଆପଣ କଣ ପରିବର୍ତ୍ତନ ଚାହୁଁଛନ୍ତି?',
    generateCharacterSheetButton: 'ଚରିତ୍ର ତିଆରି କରନ୍ତୁ',
    generatingCharacterSheetLabel: 'ଚରିତ୍ର ତିଆରି ହେଉଛି...',
    characterSheetHeading: 'ଚରିତ୍ର ତାଲିକା',
    approveCharacterSheetButton: 'ଅନୁମୋଦନ କରନ୍ତୁ',
    characterSheetApprovedBadge: '✅ ଚରିତ୍ର ଅନୁମୋଦିତ',
    characterSheetFeedbackPlaceholder: 'ଆପଣ କଣ ପରିବର୍ତ୍ତନ ଚାହୁଁଛନ୍ତି?',
    archetypeLabel: 'ଆର୍କିଟାଇପ୍',
    wantLabel: 'ଇଚ୍ଛା',
    needLabel: 'ଆବଶ୍ୟକତା',
    flawLabel: 'ଦୁର୍ବଳତା',
    virtuesLabel: 'ଗୁଣ',
    innerConflictLabel: 'ଆଭ୍ୟନ୍ତରିକ ସଂଘର୍ଷ',
    outerConflictLabel: 'ବାହ୍ୟ ସଂଘର୍ଷ',
    arcLabel: 'ପରିବର୍ତ୍ତନ ଯାତ୍ରା',
    introductionBeatLabel: 'ପରିଚୟ ମୁହୂର୍ତ୍ତ',
    heroLoglineLabel: 'ତାଙ୍କର ନିଜ କାହାଣୀ (ନାୟକ ଭାବରେ)',
    archetypeLabels: {
      hero: 'ନାୟକ',
      mentor: 'ଗୁରୁ',
      threshold_guardian: 'ସୀମା ରକ୍ଷକ',
      herald: 'ସୂଚକ',
      shapeshifter: 'ରୂପ ପରିବର୍ତ୍ତକ',
      shadow: 'ଛାୟା',
      ally: 'ସହଚର',
      trickster: 'ଠକ',
    },
    generateBitSheet: 'ବିଟ୍ ସିଟ୍ ତିଆରି କରନ୍ତୁ',
    generatingBitSheet: 'ବିଟ୍ ସିଟ୍ ତିଆରି ହେଉଛି...',
    bitSheetHeading: 'ବିଟ୍ ସିଟ୍ (କାହାଣୀ ମୋଡ଼)',
    approveBitSheetButton: 'ବିଟ୍ ସିଟ୍ ଅନୁମୋଦନ କରନ୍ତୁ',
    bitSheetApprovedBadge: '✅ ବିଟ୍ ସିଟ୍ ଅନୁମୋଦିତ',
    bitSheetFeedbackPlaceholder: 'ଆପଣ କଣ ପରିବର୍ତ୍ତନ ଚାହୁଁଛନ୍ତି?',
    bitTypeLabels: {
      opening_image: 'ଆରମ୍ଭ ଚିତ୍ର',
      theme_stated: 'ମୂଳ ଭାବ',
      catalyst: 'ପ୍ରବର୍ତ୍ତକ',
      reveal: 'ପ୍ରକାଶ',
      plot_point_1: 'କାହାଣୀ ମୋଡ଼ ୧',
      midpoint: 'ମଧ୍ୟବିନ୍ଦୁ',
      setback: 'ବିପତ୍ତି',
      all_is_lost: 'ସର୍ବନାଶ ମୁହୂର୍ତ୍ତ',
      plot_point_2: 'କାହାଣୀ ମୋଡ଼ ୨',
      crisis: 'ସଙ୍କଟ',
      climax: 'ଚରମ ମୁହୂର୍ତ୍ତ',
      realization: 'ଆତ୍ମ-ଉପଲବ୍ଧି',
      turning_point: 'ମୋଡ଼',
      resolution_beat: 'ସମାଧାନ ମୋଡ଼',
      final_image: 'ଅନ୍ତିମ ଚିତ୍ର',
    },
    scenePurposeLabels: {
      plot_advancing: 'କାହାଣୀ',
      character_revealing: 'ଚରିତ୍ର',
    },
    sceneTurnLabel: 'ମୋଡ଼',
  },
}

function formatBadgeText(format, t) {
  if (format?.type === 'series') {
    return t.formatSeries(format.episodeCount, format.episodeMinutes)
  }
  return t.formatFilm
}

const ICONS = {
  lightbulb: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path
        d="M9 18h6M10 21h4M12 3a6 6 0 0 0-6 6c0 2.5 1.5 4 2.5 5.5.5.7 1 1.5 1 2.5h5c0-1 .5-1.8 1-2.5C16.5 13 18 11.5 18 9a6 6 0 0 0-6-6Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  clapperboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 9h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9Z" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M3 9l1.5-4.5L9 6 7.5 9.5M9 9l1.5-4.5L15 6l-1.5 3.5M15 9l1.5-4.5L21 6l-1.5 3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  penNib: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 19l7-7 3 3-7 7-3-3Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 2l7.5 7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  pencil: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  pin: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 15v5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  download: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 3v12m0 0-4-4m4 4 4-4M5 19h14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  upload: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 15V3m0 0 4 4m-4-4-4 4M5 19h14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
}

function ActBlocks({ content, t, language }) {
  return (
    <>
      <div className="act-block">
        <h4>{t.setupLabel}</h4>
        <p>{content.setup.summary[language]}</p>
        <ul>
          {content.setup.beats.map((beat, index) => (
            <li key={index}>{beat[language]}</li>
          ))}
        </ul>
      </div>
      <div className="act-block">
        <h4>{t.confrontationLabel}</h4>
        <p>{content.confrontation.summary[language]}</p>
        <ul>
          {content.confrontation.beats.map((beat, index) => (
            <li key={index}>{beat[language]}</li>
          ))}
        </ul>
      </div>
      <div className="act-block">
        <h4>{t.resolutionLabel}</h4>
        <p>{content.resolution.summary[language]}</p>
        <ul>
          {content.resolution.beats.map((beat, index) => (
            <li key={index}>{beat[language]}</li>
          ))}
        </ul>
      </div>
    </>
  )
}

function EpisodeStructures({ episodeStructures, episodes, t, language }) {
  if (!episodeStructures) return null

  return (
    <div className="episode-structures">
      <h4>{t.episodeStructuresHeading}</h4>
      {episodeStructures.map((episodeStructure, index) => (
        <div key={index} className="episode-structure-card">
          <strong>
            {t.episodeLabel} {index + 1}
            {episodes?.[index] ? `: ${episodes[index].title[language]}` : ''}
          </strong>
          <ActBlocks content={episodeStructure} t={t} language={language} />
        </div>
      ))}
    </div>
  )
}

function BitRows({ bits, t, language }) {
  let lastAct = null

  return bits.map((bit, index) => {
    const showActHeader = bit.actNumber !== lastAct
    lastAct = bit.actNumber
    const actLabel =
      bit.actNumber === 1 ? t.setupLabel : bit.actNumber === 2 ? t.confrontationLabel : t.resolutionLabel

    return (
      <div key={index} className="bit-row">
        {showActHeader && <h4 className="scene-act-header">{actLabel}</h4>}
        <p className="bit-heading">
          <span className={`bit-type-badge bit-type-${bit.beatType}`}>{t.bitTypeLabels[bit.beatType]}</span>{' '}
          {bit.title[language]}
        </p>
        <p>{bit.description[language]}</p>
      </div>
    )
  })
}

function BitSheetView({ bitSheet, episodes, t, language }) {
  if (!bitSheet) return null

  if (bitSheet.episodeBits) {
    return (
      <div className="scene-list">
        {bitSheet.episodeBits.map((episodeBit, index) => (
          <div key={index} className="episode-structure-card">
            <strong>
              {t.episodeLabel} {index + 1}
              {episodes?.[index] ? `: ${episodes[index].title[language]}` : ''}
            </strong>
            <BitRows bits={episodeBit.bits} t={t} language={language} />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="scene-list">
      <BitRows bits={bitSheet.bits} t={t} language={language} />
    </div>
  )
}

function screenplayKey(episodeIndex, sceneIndex) {
  return `${episodeIndex ?? 'film'}-${sceneIndex}`
}

function countScenesInList(sceneList) {
  if (!sceneList) return 0
  if (sceneList.episodeScenes) {
    return sceneList.episodeScenes.reduce((sum, episode) => sum + episode.scenes.length, 0)
  }
  return sceneList.scenes.length
}

// Unique location names (English side, used as the stable key) across every
// scene in the list, film or series — for the availability form.
function extractUniqueLocations(sceneList) {
  if (!sceneList) return []
  const allScenes = sceneList.episodeScenes
    ? sceneList.episodeScenes.flatMap((episode) => episode.scenes)
    : sceneList.scenes
  const seen = new Set()
  const result = []
  for (const scene of allScenes) {
    if (!seen.has(scene.location.en)) {
      seen.add(scene.location.en)
      result.push(scene.location)
    }
  }
  return result
}

// Resolves a {episodeIndex, sceneIndex} shoot-schedule reference back to the
// actual scene object from the scene list, for display.
function lookupScene(sceneList, ref) {
  if (!sceneList) return null
  if (sceneList.episodeScenes) {
    return sceneList.episodeScenes[ref.episodeIndex]?.scenes[ref.sceneIndex] ?? null
  }
  return sceneList.scenes[ref.sceneIndex] ?? null
}

// Who's actually IN this one scene — pulled from the AD Scene Breakdown
// Sheet (if one's been generated), matched by the same positional order it
// was built in, rather than a whole shoot day's cast list. Falls back to
// null when no AD sheet exists yet, so the caller can fall back to the
// day's charactersNeeded instead.
function lookupSceneCast(sceneList, adSheet, ref) {
  if (!sceneList || !adSheet) return null
  let flatIndex = 0
  if (sceneList.episodeScenes) {
    for (let e = 0; e < sceneList.episodeScenes.length; e++) {
      const scenes = sceneList.episodeScenes[e].scenes
      for (let s = 0; s < scenes.length; s++) {
        if (e === ref.episodeIndex && s === ref.sceneIndex) return adSheet[flatIndex]?.mainCharacters ?? null
        flatIndex += 1
      }
    }
    return null
  }
  return adSheet[ref.sceneIndex]?.mainCharacters ?? null
}

// A raw scene number is sometimes just a code ("1A", "7") and sometimes
// the verbatim script text including the word itself ("SCENE 1") — strip
// that prefix so a label is never built as "Scene SCENE 1".
function cleanSceneNumber(raw) {
  return String(raw).replace(/^\s*(SCENE|SC)\.?\s*/i, '')
}

// wa.me needs the number in full international form with no "+", spaces, or
// leading zero. Every contact number seen in this app so far is a plain
// 10-digit Indian mobile number with no country code typed in, so that's the
// only case worth guessing at — anything already carrying a country code is
// left as-is rather than mangled.
function normalizePhoneForWhatsApp(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '')
  if (digits.length === 10) return `91${digits}`
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`
  if (digits.length >= 11) return digits
  return null
}

// A reasonable default tentative shoot start date — roughly 3 weeks out,
// enough prep time after a script breakdown before cameras roll. Just a
// starting suggestion; the Production Manager can change it before generating.
function defaultTentativeStartDate() {
  const d = new Date()
  d.setDate(d.getDate() + 21)
  return d.toISOString().slice(0, 10)
}

function ScreenplayElements({ elements, language }) {
  return (
    <div className="screenplay-elements">
      {elements.map((element, index) => {
        if (element.type === 'dialogue') {
          const modifier = element.characterModifier && element.characterModifier !== 'none' ? ` (${element.characterModifier})` : ''
          return (
            <div key={index} className="screenplay-dialogue">
              <p className="screenplay-character">{element.character}{modifier}</p>
              {element.parenthetical && (
                <p className="screenplay-parenthetical">({element.parenthetical[language]})</p>
              )}
              <p className="screenplay-dialogue-text">{element.text[language]}</p>
            </div>
          )
        }
        if (element.type === 'transition') {
          return (
            <p key={index} className="screenplay-transition">
              {element.text[language]}
            </p>
          )
        }
        if (element.type === 'flashback') {
          return (
            <p key={index} className="screenplay-flashback">
              <strong>FLASH - {element.character}'S POV:</strong> {element.text[language]}
            </p>
          )
        }
        return (
          <p key={index} className="screenplay-action">
            {element.text[language]}
          </p>
        )
      })}
    </div>
  )
}

function ScreenplayBlock({ episodeIndex, sceneIndex, t, language, screenplay }) {
  if (!screenplay) return null

  const key = screenplayKey(episodeIndex, sceneIndex)
  const draft = screenplay.scenesByKey[key]
  const isGenerating = screenplay.generatingKey === key
  const isSubmittingFeedback = screenplay.submittingFeedbackKey === key
  const showFeedbackForm = screenplay.feedbackFormKey === key

  if (!draft) {
    return (
      <button
        className="choose-button write-scene-button"
        onClick={() => screenplay.onWriteScene(episodeIndex, sceneIndex)}
        disabled={isGenerating}
      >
        {isGenerating ? t.generatingScreenplayScene : t.writeSceneButton}
      </button>
    )
  }

  return (
    <div className="screenplay-block">
      <ScreenplayElements elements={draft.elements} language={language} />

      {draft.previousFeedback && (
        <p className="feedback-note">
          <strong>{t.changesRequestedBadge}</strong> "{draft.previousFeedback}"
        </p>
      )}

      <div className="screenplay-block-actions">
        <button className="cancel-button" onClick={() => screenplay.onToggleFeedback(key)}>
          {t.requestChangesButton}
        </button>
      </div>

      {showFeedbackForm && (
        <div className="feedback-form">
          <textarea
            className="feedback-textarea"
            value={screenplay.feedbackTextByKey[key] || ''}
            onChange={(e) => screenplay.onFeedbackTextChange(key, e.target.value)}
            placeholder={t.screenplayFeedbackPlaceholder}
          />
          <button
            className="choose-button"
            onClick={() => screenplay.onSubmitFeedback(key, draft.id)}
            disabled={isSubmittingFeedback || !(screenplay.feedbackTextByKey[key] || '').trim()}
          >
            {isSubmittingFeedback ? t.submittingFeedback : t.submitFeedback}
          </button>
        </div>
      )}
    </div>
  )
}

function SceneRows({ scenes, t, language, episodeIndex, screenplay }) {
  let lastAct = null

  return scenes.map((scene, index) => {
    const showActHeader = scene.actNumber !== lastAct
    lastAct = scene.actNumber
    const actLabel =
      scene.actNumber === 1 ? t.setupLabel : scene.actNumber === 2 ? t.confrontationLabel : t.resolutionLabel
    const timeLabel = scene.timeOfDay === 'NIGHT' ? t.nightLabel : t.dayLabel

    return (
      <div key={index} className="scene-row">
        {showActHeader && <h4 className="scene-act-header">{actLabel}</h4>}
        <p className="scene-heading">
          {t.sceneLabel} {scene.sceneNumber ? cleanSceneNumber(scene.sceneNumber) : index + 1} — {scene.intExt}. {scene.location[language]} — {timeLabel}
          {typeof scene.estimatedMinutes === 'number' ? ` (${t.approxMinutesUnit(scene.estimatedMinutes)})` : ''}
        </p>
        {scene.purpose && (
          <span className={`scene-purpose-badge scene-purpose-${scene.purpose}`}>
            {t.scenePurposeLabels[scene.purpose]}
          </span>
        )}
        <p>{scene.oneLiner[language]}</p>
        {scene.turn && <p className="scene-turn">{t.sceneTurnLabel}: {scene.turn[language]}</p>}
        <ScreenplayBlock episodeIndex={episodeIndex} sceneIndex={index} t={t} language={language} screenplay={screenplay} />
      </div>
    )
  })
}

function RuntimeSummary({ total, target, t }) {
  if (typeof total !== 'number' || !target) return null
  const isMismatch = Math.abs(total - target) / target > 0.25

  return (
    <p className={isMismatch ? 'feedback-note' : 'runtime-summary'}>
      {t.totalRuntimeLabel(total, target)}
      {isMismatch && (
        <>
          <br />
          {t.runtimeMismatchNote}
        </>
      )}
    </p>
  )
}

function SceneListView({ sceneList, episodes, t, language, screenplay }) {
  if (!sceneList) return null

  if (sceneList.episodeScenes) {
    return (
      <div className="scene-list">
        {sceneList.episodeScenes.map((episodeScene, index) => (
          <div key={index} className="episode-structure-card">
            <strong>
              {t.episodeLabel} {index + 1}
              {episodes?.[index] ? `: ${episodes[index].title[language]}` : ''}
            </strong>
            <RuntimeSummary total={episodeScene.totalEstimatedMinutes} target={episodeScene.targetMinutes} t={t} />
            <SceneRows
              scenes={episodeScene.scenes}
              t={t}
              language={language}
              episodeIndex={index}
              screenplay={screenplay}
            />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="scene-list">
      <RuntimeSummary total={sceneList.totalEstimatedMinutes} target={sceneList.targetMinutes} t={t} />
      <SceneRows scenes={sceneList.scenes} t={t} language={language} episodeIndex={null} screenplay={screenplay} />
    </div>
  )
}

function CrewMemberEditForm({ member, onSave, onCancel, isSaving, t, showRole }) {
  const [editName, setEditName] = useState(member.name)
  const [editRole, setEditRole] = useState(member.role ?? '')
  const [editContactNumber, setEditContactNumber] = useState(member.contactNumber ?? '')
  const [editPhotoFile, setEditPhotoFile] = useState(null)

  return (
    <div className="crew-member-card crew-member-card-editing">
      {member.photoUrl ? (
        <img className="crew-member-photo" src={member.photoUrl} alt={member.name} />
      ) : (
        <div className="crew-member-photo crew-member-photo-placeholder">{member.name.charAt(0).toUpperCase()}</div>
      )}
      <div className="crew-member-edit-fields">
        <input type="text" placeholder={t.crewNameLabel} value={editName} onChange={(e) => setEditName(e.target.value)} />
        {showRole && (
          <input type="text" placeholder={t.crewRoleLabel} value={editRole} onChange={(e) => setEditRole(e.target.value)} />
        )}
        <input type="tel" placeholder={t.crewContactLabel} value={editContactNumber} onChange={(e) => setEditContactNumber(e.target.value)} />
        <input type="file" accept="image/*" onChange={(e) => setEditPhotoFile(e.target.files[0] ?? null)} />
      </div>
      <div className="crew-member-edit-actions">
        <button
          className="breakdown-action-button"
          disabled={isSaving || !editName.trim()}
          onClick={() => onSave({ name: editName, role: showRole ? editRole : undefined, contactNumber: editContactNumber, photoFile: editPhotoFile })}
        >
          {isSaving ? t.savingChangesLabel : t.saveChangesButton}
        </button>
        <button className="cancel-button" onClick={onCancel} disabled={isSaving}>
          {t.cancelEditButton}
        </button>
      </div>
    </div>
  )
}

function CrewSection({ category, heading, members, characterOptions, onAdd, onUpdate, onDelete, isAdding, deletingId, updatingId, t, BACKEND_URL, canEdit }) {
  const [characterName, setCharacterName] = useState(characterOptions?.[0] ?? '')
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [contactNumber, setContactNumber] = useState('')
  const [photoFile, setPhotoFile] = useState(null)
  const [editingMemberId, setEditingMemberId] = useState(null)
  const [isExpanded, setIsExpanded] = useState(false)
  const fileInputRef = useRef(null)

  // characterOptions shrinks as characters get cast (from here or from the
  // inline Script Breakdown widget, same underlying data) — keep the
  // selected value valid instead of silently pointing at an option that
  // just disappeared.
  useEffect(() => {
    if (characterOptions && !characterOptions.includes(characterName)) {
      setCharacterName(characterOptions[0] ?? '')
    }
  }, [characterOptions])

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) return
    await onAdd(category, { characterName: characterOptions ? characterName : null, name, role, contactNumber, photoFile })
    setName('')
    setRole('')
    setContactNumber('')
    setPhotoFile(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <div className="breakdown-category">
      <div className="breakdown-category-header">
        <button className="breakdown-item-toggle" onClick={() => setIsExpanded(!isExpanded)}>
          <span className={isExpanded ? 'breakdown-item-chevron expanded' : 'breakdown-item-chevron'}>▸</span>
          <h4>
            {heading} <span className="breakdown-item-meta">({members.length})</span>
          </h4>
        </button>
      </div>

      {!isExpanded ? null : (
        <>
          {members.length === 0 && <p className="sidebar-section-note">{t.noCrewMembersYet}</p>}

          <div className="crew-member-grid">
            {members.map((member) =>
              editingMemberId === member.id ? (
                <CrewMemberEditForm
                  key={member.id}
                  member={member}
                  t={t}
                  showRole={!characterOptions}
                  isSaving={updatingId === member.id}
                  onCancel={() => setEditingMemberId(null)}
                  onSave={async (updates) => {
                    await onUpdate(member.id, updates)
                    setEditingMemberId(null)
                  }}
                />
              ) : (
                <div key={member.id} className="crew-member-card">
                  {member.photoUrl ? (
                    <img className="crew-member-photo" src={member.photoUrl} alt={member.name} />
                  ) : (
                    <div className="crew-member-photo crew-member-photo-placeholder">{member.name.charAt(0).toUpperCase()}</div>
                  )}
                  <div className="crew-member-details">
                    <strong>{member.name}</strong>
                    {member.characterName && <span className="breakdown-item-meta"> — {member.characterName}</span>}
                    {member.role && <p>{member.role}</p>}
                    {member.contactNumber && <p>{member.contactNumber}</p>}
                  </div>
                  {canEdit && (
                    <div className="crew-member-card-actions">
                      <button className="breakdown-action-button" onClick={() => setEditingMemberId(member.id)}>
                        {t.modifyCrewMemberButton}
                      </button>
                      <button
                        className="breakdown-action-button crew-member-remove"
                        onClick={() => onDelete(member.id)}
                        disabled={deletingId === member.id}
                      >
                        {t.removeCrewMemberButton}
                      </button>
                    </div>
                  )}
                </div>
              )
            )}
          </div>

          {!canEdit ? null : characterOptions?.length === 0 ? (
            <p className="runtime-summary">{t.allCharactersCastNotice}</p>
          ) : (
            <form className="crew-add-form" onSubmit={handleSubmit}>
              {characterOptions && (
                <select value={characterName} onChange={(e) => setCharacterName(e.target.value)}>
                  {characterOptions.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              )}
              <input type="text" placeholder={t.crewNameLabel} value={name} onChange={(e) => setName(e.target.value)} />
              {!characterOptions && (
                <input type="text" placeholder={t.crewRoleLabel} value={role} onChange={(e) => setRole(e.target.value)} />
              )}
              <input type="tel" placeholder={t.crewContactLabel} value={contactNumber} onChange={(e) => setContactNumber(e.target.value)} />
              <input
                type="file"
                accept="image/*"
                ref={fileInputRef}
                onChange={(e) => setPhotoFile(e.target.files[0] ?? null)}
              />
              <button className="breakdown-action-button" type="submit" disabled={isAdding || !name.trim()}>
                {t.addCrewMemberButton}
              </button>
            </form>
          )}
        </>
      )}
    </div>
  )
}

// A Messenger-style slide-in panel that replaces the old bare bottom input
// bar for every "type your changes" flow in the app (breakdown revise,
// schedule revise, pitch deck revise, etc. — one per barConfig.stageKey).
// The real problem this fixes: the old bar cleared itself on submit with no
// visible trace of what was typed or whether anything actually happened —
// exactly what silently swallowed a real request earlier in this project.
// History persists per (project, stage) in localStorage so re-opening the
// panel later still shows what was asked and what happened.
function ChangesChatPanel({ t, historyKey, barConfig, isBusy }) {
  const [isOpen, setIsOpen] = useState(false)
  const [historiesByKey, setHistoriesByKey] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('filmmaking-app:chatHistories') || '{}')
    } catch {
      return {}
    }
  })
  const wasBusyRef = useRef(false)
  const messagesEndRef = useRef(null)

  const messages = historiesByKey[historyKey] ?? []

  function appendMessage(msg) {
    setHistoriesByKey((prev) => {
      const next = { ...prev, [historyKey]: [...(prev[historyKey] ?? []), msg] }
      try {
        localStorage.setItem('filmmaking-app:chatHistories', JSON.stringify(next))
      } catch {
        // Private-browsing/storage-blocked — the chat still works for this
        // session, it just won't survive a reload. Not worth surfacing.
      }
      return next
    })
  }

  useEffect(() => {
    if (wasBusyRef.current && !isBusy) {
      appendMessage({ role: 'system', text: t.changesChatAppliedMessage })
    }
    wasBusyRef.current = isBusy
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBusy])

  useEffect(() => {
    if (isOpen) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, isOpen, isBusy])

  function handleSend() {
    if (!barConfig.canSubmit) return
    appendMessage({ role: 'user', text: barConfig.value })
    barConfig.onSubmit()
  }

  return (
    <>
      <button className="changes-chat-toggle" onClick={() => setIsOpen(!isOpen)} title={t.changesChatToggleLabel}>
        {ICONS.penNib}
      </button>
      <div className={isOpen ? 'changes-chat-panel open' : 'changes-chat-panel'}>
        <div className="changes-chat-header">
          <strong>{t.changesChatHeading}</strong>
          <button className="changes-chat-close" onClick={() => setIsOpen(false)}>
            ✕
          </button>
        </div>
        <div className="changes-chat-messages">
          {messages.length === 0 && <p className="changes-chat-empty">{t.changesChatEmptyNote}</p>}
          {messages.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'changes-chat-bubble user' : 'changes-chat-bubble system'}>
              {m.text}
            </div>
          ))}
          {isBusy && (
            <div className="changes-chat-bubble system changes-chat-progress">
              <span className="changes-chat-dot" />
              <span className="changes-chat-dot" />
              <span className="changes-chat-dot" />
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        <div className="changes-chat-input-row">
          <input
            type="text"
            className="changes-chat-input"
            value={barConfig.value}
            onChange={(e) => barConfig.onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder={barConfig.placeholder}
            disabled={barConfig.disabled}
          />
          <button className="changes-chat-send" onClick={handleSend} disabled={!barConfig.canSubmit}>
            {isBusy ? '…' : '↵'}
          </button>
        </div>
      </div>
    </>
  )
}

// A single at-a-glance status view for the Director (and admin) — what's
// finalized versus still pending, computed entirely server-side from data
// that already exists (crew_members entries, completed shoot-schedule days)
// rather than a separate status flag anyone has to remember to set. The
// moment Production attaches a real actor/location or marks a shoot day
// complete, this view reflects it on its own next load.
function DirectorOverviewPanel({ sceneListId, t, BACKEND_URL }) {
  const [overview, setOverview] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)
  const [isSceneDetailOpen, setIsSceneDetailOpen] = useState(false)

  useEffect(() => {
    if (!sceneListId) return
    let cancelled = false
    setIsLoading(true)
    setError(null)
    fetch(`${BACKEND_URL}/api/scene-lists/${sceneListId}/director-overview`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        if (data.error) {
          setError(data.error)
          return
        }
        setOverview(data)
      })
      .catch(() => {
        if (!cancelled) setError('Could not load production status.')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sceneListId, BACKEND_URL])

  if (!sceneListId) return null

  return (
    <div className="director-overview-panel">
      <h3>{t.directorOverviewHeading}</h3>
      {isLoading && <p className="sidebar-section-note">{t.loadingOverviewLabel}</p>}
      {error && <p className="error-text">{error}</p>}
      {overview && (
        <>
          <div className="director-overview-summary">
            <div className="director-overview-stat">
              <strong>{overview.cast.finalizedCount}/{overview.cast.totalCount}</strong>
              <span>{t.directorOverviewCastLabel}</span>
            </div>
            <div className="director-overview-stat">
              <strong>{overview.locations.finalizedCount}/{overview.locations.totalCount}</strong>
              <span>{t.directorOverviewLocationsLabel}</span>
            </div>
            <div className="director-overview-stat">
              <strong>{overview.scenes.shotCount}/{overview.scenes.totalCount}</strong>
              <span>{t.directorOverviewScenesLabel}</span>
            </div>
            <div className="director-overview-stat">
              <strong>{overview.crewRoster.length}</strong>
              <span>{t.directorOverviewCrewLabel}</span>
            </div>
          </div>

          <div className="director-overview-section">
            <h4>{t.directorOverviewCastLabel}</h4>
            {overview.cast.characters.filter((c) => !c.finalized).length === 0 ? (
              <p className="director-overview-all-done">{t.directorOverviewAllCastFinalized}</p>
            ) : (
              <>
                <p className="director-overview-pending-note">{t.directorOverviewPendingCastNote}</p>
                <div className="director-overview-chip-list">
                  {overview.cast.characters
                    .filter((c) => !c.finalized)
                    .map((c) => (
                      <span key={c.label} className="director-overview-chip pending">
                        {c.label}
                        {c.age ? ` (${c.age}${c.gender && c.gender !== 'Unspecified' ? `, ${c.gender}` : ''})` : ''}
                      </span>
                    ))}
                </div>
              </>
            )}
          </div>

          <div className="director-overview-section">
            <h4>{t.directorOverviewLocationsLabel}</h4>
            {overview.locations.locations.filter((l) => !l.finalized).length === 0 ? (
              <p className="director-overview-all-done">{t.directorOverviewAllLocationsFinalized}</p>
            ) : (
              <>
                <p className="director-overview-pending-note">{t.directorOverviewPendingLocationsNote}</p>
                <div className="director-overview-chip-list">
                  {overview.locations.locations
                    .filter((l) => !l.finalized)
                    .map((l) => (
                      <span key={l.label} className="director-overview-chip pending">
                        {l.label}
                      </span>
                    ))}
                </div>
              </>
            )}
          </div>

          <div className="director-overview-section">
            <h4>{t.directorOverviewCrewLabel}</h4>
            {overview.crewRoster.length === 0 ? (
              <p className="director-overview-pending-note">{t.directorOverviewNoCrewNote}</p>
            ) : (
              <div className="director-overview-crew-list">
                {overview.crewRoster.map((c, i) => (
                  <div key={i} className="director-overview-crew-row">
                    <strong>{c.name}</strong> — {c.role || t.unspecifiedLabel}
                    {c.contactNumber ? ` (${c.contactNumber})` : ''}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="director-overview-section">
            <h4>{t.directorOverviewScenesLabel}</h4>
            <button className="breakdown-action-button" onClick={() => setIsSceneDetailOpen(!isSceneDetailOpen)}>
              {isSceneDetailOpen ? t.hideDetailsButton : t.showDetailsButton}
            </button>
            {isSceneDetailOpen && (
              <div className="director-overview-scene-list">
                {overview.scenes.scenes.map((s, i) => (
                  <div key={i} className={s.shot ? 'director-overview-scene-row shot' : 'director-overview-scene-row pending'}>
                    <span className="director-overview-scene-label">
                      {s.episodeLabel ? `${s.episodeLabel}, ` : ''}
                      {cleanSceneNumber(s.sceneNumber)}
                    </span>
                    <span className="director-overview-scene-oneliner">{s.oneLiner}</span>
                    <span className="director-overview-scene-status">{s.shot ? t.shotLabel : t.pendingLabel}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// Attaches real-world casting/location info directly onto a single Script
// Breakdown item — an actor's name/phone/photo against one character, or a
// confirmed location name/photo against one location — rather than making
// the user jump to the separate Crew & Cast tab and re-pick from a dropdown.
function InlineCastAttachment({
  category,
  linkKey,
  members,
  onAdd,
  onUpdate,
  onDelete,
  isAdding,
  deletingId,
  updatingId,
  t,
  BACKEND_URL,
  canEdit,
  googleConnected,
  googleContacts,
  isLoadingGoogleContacts,
  onLoadGoogleContacts,
  onAddFromContact,
  sceneListId,
  language,
  projectTitle,
}) {
  const [name, setName] = useState('')
  const [contactNumber, setContactNumber] = useState('')
  const [photoFile, setPhotoFile] = useState(null)
  const [isPickerOpen, setIsPickerOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [editingMemberId, setEditingMemberId] = useState(null)
  const [whatsappSendingId, setWhatsappSendingId] = useState(null)
  const fileInputRef = useRef(null)

  async function handleSendWhatsApp(member) {
    const phone = normalizePhoneForWhatsApp(member.contactNumber)
    if (!phone) {
      alert(t.invalidPhoneNumberNotice)
      return
    }
    setWhatsappSendingId(member.id)
    try {
      const res = await fetch(
        `${BACKEND_URL}/api/scene-lists/${sceneListId}/character-script/share-link?character=${encodeURIComponent(linkKey)}&lang=${language}`
      )
      const data = await res.json()
      if (data.error || !data.url) {
        alert(t.whatsAppShareLinkErrorNotice)
        return
      }
      const message =
        language === 'or'
          ? `ନମସ୍କାର ${member.name}! "${linkKey}"${projectTitle ? ` (${projectTitle})` : ''} ଚରିତ୍ର ପାଇଁ ଆପଣଙ୍କର ଦୃଶ୍ୟଗୁଡ଼ିକ ଏଠାରେ ଅଛି। ଦୟାକରି ଏହାକୁ ଦେଖନ୍ତୁ ଏବଂ ପ୍ରସ୍ତୁତ ହେଲେ ଏକ ସେଲ୍ଫ-ଟେପ୍ ଅଡିସନ୍ ପଠାନ୍ତୁ:\n${data.url}`
          : `Hi ${member.name}! Here are your scenes as "${linkKey}"${projectTitle ? ` for "${projectTitle}"` : ''}. Please go through them and send a self-tape when you're ready:\n${data.url}`
      window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank')
    } catch {
      alert(t.whatsAppShareLinkErrorNotice)
    } finally {
      setWhatsappSendingId(null)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) return
    await onAdd(category, { characterName: linkKey, name, contactNumber: category === 'artist' ? contactNumber : null, photoFile })
    setName('')
    setContactNumber('')
    setPhotoFile(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function handleTogglePicker() {
    if (!isPickerOpen) await onLoadGoogleContacts()
    setIsPickerOpen(!isPickerOpen)
  }

  async function handlePickContact(contact) {
    setIsPickerOpen(false)
    setSearchTerm('')
    await onAddFromContact(category, {
      characterName: linkKey,
      name: contact.name,
      contactNumber: contact.phone,
      photoUrl: contact.photoUrl,
    })
  }

  const filteredContacts = (googleContacts ?? []).filter((c) => c.name.toLowerCase().includes(searchTerm.toLowerCase()))

  return (
    <div className="inline-cast-attachment">
      {members.length > 0 && (
        <div className="crew-member-grid">
          {members.map((member) =>
            editingMemberId === member.id ? (
              <CrewMemberEditForm
                key={member.id}
                member={member}
                t={t}
                showRole={false}
                isSaving={updatingId === member.id}
                onCancel={() => setEditingMemberId(null)}
                onSave={async (updates) => {
                  await onUpdate(member.id, updates)
                  setEditingMemberId(null)
                }}
              />
            ) : (
              <div key={member.id} className="crew-member-card">
                {member.photoUrl ? (
                  <img className="crew-member-photo" src={member.photoUrl} alt={member.name} />
                ) : (
                  <div className="crew-member-photo crew-member-photo-placeholder">{member.name.charAt(0).toUpperCase()}</div>
                )}
                <div className="crew-member-details">
                  <strong>{member.name}</strong>
                  {member.contactNumber && <p>{member.contactNumber}</p>}
                </div>
                {category === 'artist' && member.contactNumber && (
                  <button
                    className="breakdown-action-button whatsapp-send-button"
                    onClick={() => handleSendWhatsApp(member)}
                    disabled={whatsappSendingId === member.id}
                  >
                    {whatsappSendingId === member.id ? t.sendingWhatsAppLabel : t.sendWhatsAppButton}
                  </button>
                )}
                {canEdit && (
                  <div className="crew-member-card-actions">
                    <button className="breakdown-action-button" onClick={() => setEditingMemberId(member.id)}>
                      {t.modifyCrewMemberButton}
                    </button>
                    <button
                      className="breakdown-action-button crew-member-remove"
                      onClick={() => onDelete(member.id)}
                      disabled={deletingId === member.id}
                    >
                      {t.removeCrewMemberButton}
                    </button>
                  </div>
                )}
              </div>
            )
          )}
        </div>
      )}
      {canEdit && (
        <form className="crew-add-form inline-cast-form" onSubmit={handleSubmit}>
          <input
            type="text"
            placeholder={category === 'artist' ? t.castingActorNamePlaceholder : t.locationConfirmedNamePlaceholder}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {category === 'artist' && (
            <input type="tel" placeholder={t.crewContactLabel} value={contactNumber} onChange={(e) => setContactNumber(e.target.value)} />
          )}
          <input type="file" accept="image/*" ref={fileInputRef} onChange={(e) => setPhotoFile(e.target.files[0] ?? null)} />
          <button className="breakdown-action-button" type="submit" disabled={isAdding || !name.trim()}>
            {t.addCrewMemberButton}
          </button>
          {googleConnected && category === 'artist' && (
            <button type="button" className="breakdown-action-button" onClick={handleTogglePicker}>
              {t.pickFromContactsButton}
            </button>
          )}
        </form>
      )}

      {category === 'artist' && (
        <a
          className="breakdown-pdf-link audition-sides-link"
          href={`${BACKEND_URL}/api/scene-lists/${sceneListId}/character-script/export?character=${encodeURIComponent(linkKey)}&lang=${language}`}
          title={t.auditionSidesHint}
        >
          {t.downloadAuditionSidesButton}
        </a>
      )}

      {isPickerOpen && (
        <div className="contact-picker">
          <input
            type="text"
            className="contact-picker-search"
            placeholder={t.searchContactsPlaceholder}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            autoFocus
          />
          {isLoadingGoogleContacts ? (
            <p className="sidebar-section-note">{t.loadingContactsLabel}</p>
          ) : filteredContacts.length === 0 ? (
            <p className="sidebar-section-note">{t.noContactsFound}</p>
          ) : (
            <div className="contact-picker-list">
              {filteredContacts.slice(0, 20).map((contact, index) => (
                <button
                  type="button"
                  key={index}
                  className="contact-picker-item"
                  onClick={() => handlePickContact(contact)}
                >
                  {contact.photoUrl ? (
                    <img className="crew-member-photo" src={contact.photoUrl} alt={contact.name} referrerPolicy="no-referrer" />
                  ) : (
                    <div className="crew-member-photo crew-member-photo-placeholder">{contact.name.charAt(0).toUpperCase()}</div>
                  )}
                  <span>{contact.name}{contact.phone ? ` — ${contact.phone}` : ''}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function App() {
  const importFileInputRef = useRef(null)
  const screenplayFileInputRef = useRef(null)
  const reimportScreenplayFileInputRef = useRef(null)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [language, setLanguage] = useState('en')
  const [concept, setConcept] = useState('')
  const [conceptId, setConceptId] = useState(null)
  const [projectTitle, setProjectTitle] = useState(null)
  const [projectHistory, setProjectHistory] = useState([])
  const [startStage, setStartStage] = useState('idea')
  const [skipPastedText, setSkipPastedText] = useState('')
  const [skipRuntimeMinutes, setSkipRuntimeMinutes] = useState(120)
  const [isSkippingAhead, setIsSkippingAhead] = useState(false)
  const [storylines, setStorylines] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [pitchDeck, setPitchDeck] = useState(null)
  const [isGeneratingPitchDeck, setIsGeneratingPitchDeck] = useState(false)

  const [pendingStoryline, setPendingStoryline] = useState(null)
  const [regenerateFeedback, setRegenerateFeedback] = useState('')
  const [reviseFeedback, setReviseFeedback] = useState('')
  const [formatType, setFormatType] = useState('film')
  const [episodeCount, setEpisodeCount] = useState(10)
  const [episodeMinutes, setEpisodeMinutes] = useState(10)
  const [runtimeMinutes, setRuntimeMinutes] = useState(120)
  const [errorMessage, setErrorMessage] = useState(null)

  const [showFeedbackForm, setShowFeedbackForm] = useState(false)
  const [feedbackText, setFeedbackText] = useState('')
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false)
  const [isApproving, setIsApproving] = useState(false)

  const [characterSheet, setCharacterSheet] = useState(null)
  const [isGeneratingCharacterSheet, setIsGeneratingCharacterSheet] = useState(false)
  const [isApprovingCharacterSheet, setIsApprovingCharacterSheet] = useState(false)
  const [showCharacterSheetFeedbackForm, setShowCharacterSheetFeedbackForm] = useState(false)
  const [characterSheetFeedbackText, setCharacterSheetFeedbackText] = useState('')
  const [isSubmittingCharacterSheetFeedback, setIsSubmittingCharacterSheetFeedback] = useState(false)

  const [threeActStructure, setThreeActStructure] = useState(null)
  const [isGeneratingStructure, setIsGeneratingStructure] = useState(false)
  const [structureHistory, setStructureHistory] = useState([])
  const [isLockingStructure, setIsLockingStructure] = useState(false)
  const [showStructureFeedbackForm, setShowStructureFeedbackForm] = useState(false)
  const [structureFeedbackText, setStructureFeedbackText] = useState('')
  const [isSubmittingStructureFeedback, setIsSubmittingStructureFeedback] = useState(false)
  const [expandedVersionId, setExpandedVersionId] = useState(null)
  const [expandedVersionContent, setExpandedVersionContent] = useState(null)

  const [bitSheet, setBitSheet] = useState(null)
  const [isGeneratingBitSheet, setIsGeneratingBitSheet] = useState(false)
  const [isApprovingBitSheet, setIsApprovingBitSheet] = useState(false)
  const [showBitSheetFeedbackForm, setShowBitSheetFeedbackForm] = useState(false)
  const [bitSheetFeedbackText, setBitSheetFeedbackText] = useState('')
  const [isSubmittingBitSheetFeedback, setIsSubmittingBitSheetFeedback] = useState(false)

  const [sceneList, setSceneList] = useState(null)
  const [isGeneratingSceneList, setIsGeneratingSceneList] = useState(false)
  const [isApprovingSceneList, setIsApprovingSceneList] = useState(false)
  const [showSceneListFeedbackForm, setShowSceneListFeedbackForm] = useState(false)
  const [sceneListFeedbackText, setSceneListFeedbackText] = useState('')
  const [isSubmittingSceneListFeedback, setIsSubmittingSceneListFeedback] = useState(false)

  const [screenplayScenesByKey, setScreenplayScenesByKey] = useState({})
  const [generatingScreenplayKey, setGeneratingScreenplayKey] = useState(null)
  const [screenplayFeedbackFormKey, setScreenplayFeedbackFormKey] = useState(null)
  const [screenplayFeedbackTextByKey, setScreenplayFeedbackTextByKey] = useState({})
  const [submittingScreenplayFeedbackKey, setSubmittingScreenplayFeedbackKey] = useState(null)

  const [scriptBreakdown, setScriptBreakdown] = useState(null)
  const [isGeneratingBreakdown, setIsGeneratingBreakdown] = useState(false)
  const [isGeneratingAdSheet, setIsGeneratingAdSheet] = useState(false)
  const [isApprovingBreakdown, setIsApprovingBreakdown] = useState(false)
  const [showBreakdownFeedbackForm, setShowBreakdownFeedbackForm] = useState(false)
  const [breakdownFeedbackText, setBreakdownFeedbackText] = useState('')
  const [isSubmittingBreakdownFeedback, setIsSubmittingBreakdownFeedback] = useState(false)
  const [reanalyzingCategory, setReanalyzingCategory] = useState(null)
  const [editingBreakdownCategory, setEditingBreakdownCategory] = useState(null)
  const [breakdownCategoryDraft, setBreakdownCategoryDraft] = useState([])
  const [isSavingBreakdownEdits, setIsSavingBreakdownEdits] = useState(false)
  const [expandedBreakdownItems, setExpandedBreakdownItems] = useState({})

  function toggleBreakdownItem(key) {
    setExpandedBreakdownItems((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  // Categories collapse to just their heading by default — only the items
  // inside expand further (per-item, handled by expandedBreakdownItems
  // above), so a long breakdown starts as a short list of category names
  // rather than everything open at once.
  const [expandedBreakdownCategories, setExpandedBreakdownCategories] = useState({})

  function toggleBreakdownCategory(category) {
    setExpandedBreakdownCategories((prev) => ({ ...prev, [category]: !prev[category] }))
  }

  const [expandedScheduleDays, setExpandedScheduleDays] = useState({})
  const [isArtistScheduleExpanded, setIsArtistScheduleExpanded] = useState(false)

  function toggleScheduleDay(dayNumber) {
    setExpandedScheduleDays((prev) => ({ ...prev, [dayNumber]: !prev[dayNumber] }))
  }

  const [crewMembers, setCrewMembers] = useState([])
  const [isAddingCrew, setIsAddingCrew] = useState(false)
  const [crewDeletingId, setCrewDeletingId] = useState(null)
  const [crewUpdatingId, setCrewUpdatingId] = useState(null)
  const [newCastCharacterName, setNewCastCharacterName] = useState('')
  const [isAddingCastCharacter, setIsAddingCastCharacter] = useState(false)
  const [isFindingMissingCharacters, setIsFindingMissingCharacters] = useState(false)
  const [foundMissingCharacters, setFoundMissingCharacters] = useState(null)
  const [isExportingProject, setIsExportingProject] = useState(false)

  const [googleConnected, setGoogleConnected] = useState(false)
  const [googleContacts, setGoogleContacts] = useState(null)
  const [isLoadingGoogleContacts, setIsLoadingGoogleContacts] = useState(false)
  const [googleContactsNotice, setGoogleContactsNotice] = useState(null)

  // undefined = still checking; null = not logged in; object = logged in.
  const [currentUser, setCurrentUser] = useState(undefined)
  const [loginUsername, setLoginUsername] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginError, setLoginError] = useState(null)
  const [isLoggingIn, setIsLoggingIn] = useState(false)

  const [showManageUsers, setShowManageUsers] = useState(false)
  const [users, setUsers] = useState([])
  const [newUserName, setNewUserName] = useState('')
  const [newUserUsername, setNewUserUsername] = useState('')
  const [newUserPassword, setNewUserPassword] = useState('')
  const [newUserRole, setNewUserRole] = useState('production_manager')
  const [newUserConceptId, setNewUserConceptId] = useState('')
  const [isCreatingUser, setIsCreatingUser] = useState(false)
  const [userManagementError, setUserManagementError] = useState(null)

  const [shootSchedule, setShootSchedule] = useState(null)
  const [isGeneratingSchedule, setIsGeneratingSchedule] = useState(false)
  const [isApprovingSchedule, setIsApprovingSchedule] = useState(false)
  const [showScheduleFeedbackForm, setShowScheduleFeedbackForm] = useState(false)
  const [scheduleFeedbackText, setScheduleFeedbackText] = useState('')
  const [isSubmittingScheduleFeedback, setIsSubmittingScheduleFeedback] = useState(false)
  const [characterAvailability, setCharacterAvailability] = useState({})
  const [locationAvailability, setLocationAvailability] = useState({})
  const [scheduleStartDate, setScheduleStartDate] = useState(defaultTentativeStartDate())
  const [scheduleTargetDays, setScheduleTargetDays] = useState(10)
  const [scheduleSpecialInstructions, setScheduleSpecialInstructions] = useState('')
  const [markingShotDayNumber, setMarkingShotDayNumber] = useState(null)
  const [shotSceneSelections, setShotSceneSelections] = useState({})
  const [shotCompletionNote, setShotCompletionNote] = useState('')
  const [isRecordingShotDay, setIsRecordingShotDay] = useState(false)
  const [dayCompletionReportText, setDayCompletionReportText] = useState('')
  const [isParsingDayCompletion, setIsParsingDayCompletion] = useState(false)
  const [dayCompletionParseResult, setDayCompletionParseResult] = useState(null)

  const [activeAgent, setActiveAgent] = useState('story')
  const [projectType, setProjectType] = useState('story')
  const [masterProjectList, setMasterProjectList] = useState([])
  const [isLoadingMasterList, setIsLoadingMasterList] = useState(false)
  const [importScreenplayText, setImportScreenplayText] = useState('')
  const [isImportingScreenplay, setIsImportingScreenplay] = useState(false)
  const [isImportingScreenplayFile, setIsImportingScreenplayFile] = useState(false)
  const [showReimportForm, setShowReimportForm] = useState(false)
  const [reimportScreenplayText, setReimportScreenplayText] = useState('')
  const [isReimportingScreenplay, setIsReimportingScreenplay] = useState(false)
  const [reimportResult, setReimportResult] = useState(null)

  const t = LABELS[language]
  // Mirrors the backend's requireRole checks — hiding a control here is
  // purely UX (the real enforcement is server-side), so a director never
  // sees an Edit/Generate button that would just 403 if clicked, and a
  // production manager never sees an Approve button for work they did
  // themselves.
  const canEditProduction = currentUser?.role === 'admin' || currentUser?.role === 'production_manager'
  const canReviewProduction = currentUser?.role === 'admin' || currentUser?.role === 'director'
  // Narrower than canEditProduction: importing/analyzing a script is a
  // one-time curation step, not ongoing production work — a per-project
  // team account keeps Crew & Cast and Shoot Schedule generation, but only
  // the admin can import a new screenplay or re-run/edit the breakdown, so
  // a team can't repurpose the analysis pipeline for something else.
  const canAnalyzeScript = currentUser?.role === 'admin'
  const isScopedToOneProject = currentUser?.role !== 'admin'

  function buildFormatObject() {
    return formatType === 'series'
      ? { type: 'series', episodeCount: Number(episodeCount), episodeMinutes: Number(episodeMinutes) }
      : { type: 'film', runtimeMinutes: Number(runtimeMinutes) }
  }

  async function loadStructureHistory(pitchDeckId) {
    const response = await fetch(`${BACKEND_URL}/api/three-act-structure/history?pitchDeckId=${pitchDeckId}`)
    const data = await response.json()
    setStructureHistory(data)
  }

  async function loadScreenplayScenes(sceneListId) {
    const response = await fetch(`${BACKEND_URL}/api/screenplay/scenes?sceneListId=${sceneListId}`)
    const data = await response.json()
    const map = {}
    data.forEach((scene) => {
      map[screenplayKey(scene.episodeIndex, scene.sceneIndex)] = scene
    })
    setScreenplayScenesByKey(map)
  }

  async function loadCrewMembers(sceneListId) {
    const response = await fetch(`${BACKEND_URL}/api/crew?sceneListId=${sceneListId}`)
    if (!response.ok) return
    setCrewMembers(await response.json())
  }

  async function handleAddCrewMember(category, { characterName, name, role, contactNumber, photoFile }) {
    if (!name.trim()) return

    setIsAddingCrew(true)
    setErrorMessage(null)

    try {
      const formData = new FormData()
      formData.append('sceneListId', sceneList.id)
      formData.append('category', category)
      if (characterName) formData.append('characterName', characterName)
      formData.append('name', name)
      if (role) formData.append('role', role)
      if (contactNumber) formData.append('contactNumber', contactNumber)
      if (photoFile) formData.append('photo', photoFile)

      const response = await fetch(`${BACKEND_URL}/api/crew`, { method: 'POST', body: formData })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsAddingCrew(false)
        return
      }

      setCrewMembers((prev) => [...prev, data])
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsAddingCrew(false)
  }

  async function handleUpdateCrewMember(id, { name, role, contactNumber, photoFile }) {
    setCrewUpdatingId(id)
    setErrorMessage(null)

    try {
      const formData = new FormData()
      formData.append('name', name)
      if (role != null) formData.append('role', role)
      if (contactNumber != null) formData.append('contactNumber', contactNumber)
      if (photoFile) formData.append('photo', photoFile)

      const response = await fetch(`${BACKEND_URL}/api/crew/${id}`, { method: 'PATCH', body: formData })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setCrewUpdatingId(null)
        return
      }

      setCrewMembers((prev) => prev.map((member) => (member.id === id ? data : member)))
    } catch {
      setErrorMessage(t.genericError)
    }

    setCrewUpdatingId(null)
  }

  async function handleDeleteCrewMember(id) {
    setCrewDeletingId(id)
    try {
      await fetch(`${BACKEND_URL}/api/crew/${id}`, { method: 'DELETE' })
      setCrewMembers((prev) => prev.filter((member) => member.id !== id))
    } catch {
      setErrorMessage(t.genericError)
    }
    setCrewDeletingId(null)
  }

  async function loadProjectList() {
    const response = await fetch(`${BACKEND_URL}/api/concepts`)
    const data = await response.json()
    setProjectHistory(data)
  }

  async function loadMasterProjectList() {
    setIsLoadingMasterList(true)
    const response = await fetch(`${BACKEND_URL}/api/projects/master-list`)
    if (response.ok) {
      setMasterProjectList(await response.json())
    }
    setIsLoadingMasterList(false)
  }

  function handleOpenMasterProjectClick(project) {
    setIsSidebarOpen(false)
    setActiveAgent(project.projectType === 'production' ? 'production' : 'story')
    loadProject(project.id)
  }

  // Loads exactly one project's full chain by its concept id — never "whatever's newest
  // anywhere," which was the root cause of the app appearing to randomly jump projects.
  async function loadProject(id) {
    setIsSidebarOpen(false)
    const response = await fetch(`${BACKEND_URL}/api/concepts/${id}/full`)
    if (!response.ok) return
    const data = await response.json()

    setConceptId(data.conceptId)
    setConcept(data.concept)
    setProjectTitle(data.title)
    setStorylines(data.storylines)
    setPendingStoryline(null)
    setRegenerateFeedback('')
    setReviseFeedback('')
    setErrorMessage(null)
    setProjectType(data.projectType ?? 'story')
    setActiveAgent(data.projectType === 'production' ? 'production' : 'story')

    setPitchDeck(data.pitchDeck)
    setShowFeedbackForm(false)
    setFeedbackText('')

    setCharacterSheet(data.characterSheet)
    setShowCharacterSheetFeedbackForm(false)
    setCharacterSheetFeedbackText('')

    setThreeActStructure(data.threeActStructure)
    setStructureHistory([])
    setShowStructureFeedbackForm(false)
    setStructureFeedbackText('')
    setExpandedVersionId(null)
    setExpandedVersionContent(null)
    if (data.threeActStructure) {
      loadStructureHistory(data.pitchDeck.id)
    }

    setBitSheet(data.bitSheet)
    setShowBitSheetFeedbackForm(false)
    setBitSheetFeedbackText('')

    setSceneList(data.sceneList)
    setShowSceneListFeedbackForm(false)
    setSceneListFeedbackText('')
    setScreenplayScenesByKey({})
    setScreenplayFeedbackFormKey(null)
    setScreenplayFeedbackTextByKey({})
    if (data.sceneList && data.sceneList.status === 'approved') {
      loadScreenplayScenes(data.sceneList.id)
    }

    setCrewMembers([])
    if (data.sceneList) {
      loadCrewMembers(data.sceneList.id)
    }

    setScriptBreakdown(data.scriptBreakdown)
    setShowBreakdownFeedbackForm(false)
    setBreakdownFeedbackText('')
    setEditingBreakdownCategory(null)
    setBreakdownCategoryDraft([])

    setShootSchedule(data.shootSchedule)
    setShowScheduleFeedbackForm(false)
    setScheduleFeedbackText('')
    setCharacterAvailability({})
    setLocationAvailability({})
    setScheduleStartDate(data.shootSchedule?.availability?.startDate ?? defaultTentativeStartDate())
    setScheduleTargetDays(data.shootSchedule?.targetDays ?? 10)

    localStorage.setItem(CURRENT_CONCEPT_STORAGE_KEY, String(id))
  }

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/auth/me`)
      .then((res) => res.json())
      .then((data) => {
        setCurrentUser(data)
        // A restored session (page reload) needs this too, not just a
        // fresh login — otherwise a director's browser defaults to the
        // 'story' agent (its initial state) and Story & Screenplay's
        // content renders even though its nav entry is hidden.
        if (data && data.role !== 'admin') setActiveAgent('production')
      })
      .catch(() => setCurrentUser(null))
  }, [])

  async function handleLoginSubmit(e) {
    e.preventDefault()
    setIsLoggingIn(true)
    setLoginError(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUsername, password: loginPassword }),
      })
      const data = await response.json()

      if (!response.ok) {
        setLoginError(data.error || t.genericError)
        setIsLoggingIn(false)
        return
      }

      setCurrentUser(data)
      setLoginPassword('')
      if (data.role !== 'admin') setActiveAgent('production')
    } catch {
      setLoginError(t.genericError)
    }

    setIsLoggingIn(false)
  }

  async function handleLogoutClick() {
    await fetch(`${BACKEND_URL}/api/auth/logout`, { method: 'POST' })
    setCurrentUser(null)
    localStorage.removeItem(CURRENT_CONCEPT_STORAGE_KEY)
  }

  async function loadUsers() {
    const response = await fetch(`${BACKEND_URL}/api/auth/users`)
    if (response.ok) setUsers(await response.json())
  }

  async function handleToggleManageUsers() {
    if (!showManageUsers) await loadUsers()
    setShowManageUsers(!showManageUsers)
  }

  async function handleCreateUserSubmit(e) {
    e.preventDefault()
    setIsCreatingUser(true)
    setUserManagementError(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/auth/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newUserName,
          username: newUserUsername,
          password: newUserPassword,
          role: newUserRole,
          conceptId: newUserRole === 'admin' ? null : newUserConceptId,
        }),
      })
      const data = await response.json()

      if (!response.ok) {
        setUserManagementError(data.error || t.genericError)
        setIsCreatingUser(false)
        return
      }

      setUsers((prev) => [...prev, data])
      setNewUserName('')
      setNewUserUsername('')
      setNewUserPassword('')
      setNewUserConceptId('')
    } catch {
      setUserManagementError(t.genericError)
    }

    setIsCreatingUser(false)
  }

  async function handleDeleteUserClick(id) {
    await fetch(`${BACKEND_URL}/api/auth/users/${id}`, { method: 'DELETE' })
    setUsers((prev) => prev.filter((u) => u.id !== id))
  }

  // Everything that loads real project data waits until we know who's
  // logged in — these fetches would 401 otherwise.
  useEffect(() => {
    if (!currentUser) return

    loadProjectList()

    // A scoped team account only ever has the one project it was assigned
    // to — load it directly rather than relying on localStorage, which
    // won't be set yet on a device they haven't used before.
    if (currentUser.role !== 'admin' && currentUser.conceptId) {
      loadProject(currentUser.conceptId)
    } else {
      const savedConceptId = localStorage.getItem(CURRENT_CONCEPT_STORAGE_KEY)
      if (savedConceptId) {
        loadProject(savedConceptId)
      }
    }

    if (currentUser.role !== 'director') {
      fetch(`${BACKEND_URL}/api/google/status`)
        .then((res) => res.json())
        .then((data) => setGoogleConnected(data.connected))
        .catch(() => {})
    }

    const params = new URLSearchParams(window.location.search)
    if (params.has('googleContactsConnected')) {
      setGoogleConnected(true)
      setGoogleContactsNotice('connected')
      window.history.replaceState({}, '', window.location.pathname)
    } else if (params.has('googleContactsError')) {
      setGoogleContactsNotice('error')
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [currentUser])

  async function loadGoogleContacts() {
    if (googleContacts) return googleContacts

    setIsLoadingGoogleContacts(true)
    try {
      const response = await fetch(`${BACKEND_URL}/api/google/contacts`)
      const data = await response.json()
      if (!response.ok) {
        setIsLoadingGoogleContacts(false)
        return []
      }
      setGoogleContacts(data)
      setIsLoadingGoogleContacts(false)
      return data
    } catch {
      setIsLoadingGoogleContacts(false)
      return []
    }
  }

  async function handleAddCrewMemberFromContact(category, { characterName, name, contactNumber, photoUrl }) {
    setIsAddingCrew(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/crew/from-contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneListId: sceneList.id, category, characterName, name, contactNumber, photoUrl }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsAddingCrew(false)
        return
      }

      setCrewMembers((prev) => [...prev, data])
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsAddingCrew(false)
  }

  function handleNewIdeaClick() {
    localStorage.removeItem(CURRENT_CONCEPT_STORAGE_KEY)
    setConcept('')
    setConceptId(null)
    setProjectTitle(null)
    setStorylines(null)
    setPendingStoryline(null)
    setRegenerateFeedback('')
    setReviseFeedback('')
    setErrorMessage(null)
    setPitchDeck(null)
    setShowFeedbackForm(false)
    setFeedbackText('')
    setCharacterSheet(null)
    setShowCharacterSheetFeedbackForm(false)
    setCharacterSheetFeedbackText('')
    setThreeActStructure(null)
    setStructureHistory([])
    setShowStructureFeedbackForm(false)
    setStructureFeedbackText('')
    setExpandedVersionId(null)
    setExpandedVersionContent(null)
    setBitSheet(null)
    setShowBitSheetFeedbackForm(false)
    setBitSheetFeedbackText('')
    setSceneList(null)
    setShowSceneListFeedbackForm(false)
    setSceneListFeedbackText('')
    setScreenplayScenesByKey({})
    setScreenplayFeedbackFormKey(null)
    setScreenplayFeedbackTextByKey({})
    setScriptBreakdown(null)
    setShowBreakdownFeedbackForm(false)
    setBreakdownFeedbackText('')
    setEditingBreakdownCategory(null)
    setBreakdownCategoryDraft([])
    setShootSchedule(null)
    setShowScheduleFeedbackForm(false)
    setScheduleFeedbackText('')
    setCharacterAvailability({})
    setLocationAvailability({})
    setScheduleStartDate(defaultTentativeStartDate())
    setScheduleTargetDays(10)
    setProjectType(activeAgent)
    setImportScreenplayText('')
  }

  async function handleRenameProjectClick() {
    if (!conceptId) return
    const currentLabel = projectTitle || (pitchDeck ? pitchDeck.title[language] : concept)
    const nextTitle = window.prompt(t.renameProjectPrompt, currentLabel)
    if (nextTitle === null) return

    const trimmed = nextTitle.trim()
    const response = await fetch(`${BACKEND_URL}/api/concepts/${conceptId}/title`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: trimmed || null }),
    })
    if (!response.ok) return

    const data = await response.json()
    setProjectTitle(data.title)
    loadProjectList()
  }

  async function handlePinToggleClick(item) {
    await fetch(`${BACKEND_URL}/api/concepts/${item.id}/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: !item.pinned }),
    })
    loadProjectList()
  }

  async function handleDeleteProjectClick(item) {
    if (!window.confirm(t.deleteProjectConfirm)) return

    await fetch(`${BACKEND_URL}/api/concepts/${item.id}`, { method: 'DELETE' })

    if (item.id === conceptId) {
      handleNewIdeaClick()
    }
    loadProjectList()
  }

  async function urlToDataUrl(url) {
    const response = await fetch(url)
    const blob = await response.blob()
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  async function handleExportClick() {
    if (!conceptId) return

    setIsExportingProject(true)
    setErrorMessage(null)

    try {
      const crewMembersWithPhotos = await Promise.all(
        crewMembers.map(async (member) => ({
          ...member,
          photoDataUrl: member.photoUrl ? await urlToDataUrl(member.photoUrl).catch(() => null) : null,
        }))
      )

      const project = {
        projectType,
        concept,
        title: projectTitle,
        storylines,
        pitchDeck,
        characterSheet,
        threeActStructure,
        bitSheet,
        sceneList,
        screenplayScenes: Object.values(screenplayScenesByKey),
        scriptBreakdown,
        shootSchedule,
        crewMembers: crewMembersWithPhotos,
      }
      // Bumped from version 1: this now round-trips the script breakdown,
      // project type, and crew/cast (including photos, inlined as base64) —
      // a v1 export missed all of those on import.
      const payload = { exportedFrom: 'filmmaking-app', version: 2, project }

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      const nameBase = (projectTitle || concept || 'project').slice(0, 40).replace(/[^\w\- ]/g, '').trim() || 'project'
      link.href = url
      link.download = `${nameBase}.json`
      link.click()
      URL.revokeObjectURL(url)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsExportingProject(false)
  }

  async function handleImportFileSelected(event) {
    const file = event.target.files[0]
    event.target.value = ''
    if (!file) return

    setErrorMessage(null)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)

      const response = await fetch(`${BACKEND_URL}/api/concepts/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: parsed.project }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        return
      }

      await loadProject(data.conceptId)
      loadProjectList()
    } catch {
      setErrorMessage(t.importInvalidFile)
    }
  }

  async function handleSkipAheadSubmit() {
    if (!skipPastedText.trim()) return

    setIsSkippingAhead(true)
    setErrorMessage(null)

    const endpoint =
      startStage === 'synopsis'
        ? '/api/skip-to-synopsis'
        : startStage === 'bitsheet'
          ? '/api/skip-to-bitsheet'
          : '/api/skip-to-scenelist'

    try {
      const response = await fetch(`${BACKEND_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pastedText: skipPastedText, runtimeMinutes: skipRuntimeMinutes }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsSkippingAhead(false)
        return
      }

      setSkipPastedText('')
      setStartStage('idea')
      await loadProject(data.conceptId)
      loadProjectList()
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsSkippingAhead(false)
  }

  async function handleGenerateClick() {
    setIsLoading(true)
    setStorylines(null)
    setPitchDeck(null)
    setPendingStoryline(null)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/generate-storylines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ concept, format: buildFormatObject() }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsLoading(false)
        return
      }

      setConceptId(data.conceptId)
      setProjectTitle(null)
      setStorylines(data.storylines)
      localStorage.setItem(CURRENT_CONCEPT_STORAGE_KEY, String(data.conceptId))
      loadProjectList()
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsLoading(false)
  }

  async function handleRegenerateStorylinesClick() {
    setIsLoading(true)
    setErrorMessage(null)
    setStorylines(null)
    setPendingStoryline(null)

    const conceptWithFeedback = regenerateFeedback.trim()
      ? `${concept}\n\nAdditional guidance for this next attempt: ${regenerateFeedback.trim()}`
      : concept

    try {
      const response = await fetch(`${BACKEND_URL}/api/generate-storylines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ concept: conceptWithFeedback, format: buildFormatObject() }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsLoading(false)
        return
      }

      setConceptId(data.conceptId)
      setProjectTitle(null)
      setStorylines(data.storylines)
      setRegenerateFeedback('')
      localStorage.setItem(CURRENT_CONCEPT_STORAGE_KEY, String(data.conceptId))
      loadProjectList()
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsLoading(false)
  }

  // Format was already chosen on the very first screen, before the idea was
  // even typed — so choosing a storyline goes straight into building the
  // pitch deck instead of asking a second, now-redundant film/series question.
  async function handleChooseClick(storyline) {
    setPendingStoryline(storyline)
    setErrorMessage(null)
    setIsGeneratingPitchDeck(true)
    setShowFeedbackForm(false)
    setFeedbackText('')
    setThreeActStructure(null)
    setStructureHistory([])
    setExpandedVersionId(null)
    setExpandedVersionContent(null)
    setSceneList(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/pitch-deck`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conceptId, storyline, format: buildFormatObject() }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setPendingStoryline(null)
        setIsGeneratingPitchDeck(false)
        return
      }

      setPitchDeck(data)
    } catch {
      setErrorMessage(t.genericError)
      setPendingStoryline(null)
    }

    setIsGeneratingPitchDeck(false)
  }

  async function handleApproveClick() {
    setIsApproving(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/pitch-deck/${pitchDeck.id}/approve`, {
        method: 'POST',
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsApproving(false)
        return
      }

      setPitchDeck(data)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsApproving(false)
  }

  async function handleSubmitFeedbackClick(overrideText) {
    const feedback = typeof overrideText === 'string' ? overrideText : feedbackText
    setIsSubmittingFeedback(true)
    setErrorMessage(null)
    setCharacterSheet(null)
    setThreeActStructure(null)
    setStructureHistory([])
    setExpandedVersionId(null)
    setExpandedVersionContent(null)
    setSceneList(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/pitch-deck/${pitchDeck.id}/request-changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsSubmittingFeedback(false)
        return
      }

      setPitchDeck(data)
      setShowFeedbackForm(false)
      setFeedbackText('')
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsSubmittingFeedback(false)
  }

  async function handleGenerateCharacterSheetClick() {
    setIsGeneratingCharacterSheet(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/character-sheet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pitchDeckId: pitchDeck.id }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsGeneratingCharacterSheet(false)
        return
      }

      setCharacterSheet(data)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsGeneratingCharacterSheet(false)
  }

  async function handleApproveCharacterSheetClick() {
    setIsApprovingCharacterSheet(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/character-sheet/${characterSheet.id}/approve`, {
        method: 'POST',
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsApprovingCharacterSheet(false)
        return
      }

      setCharacterSheet(data)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsApprovingCharacterSheet(false)
  }

  async function handleSubmitCharacterSheetFeedbackClick(overrideText) {
    const feedback = typeof overrideText === 'string' ? overrideText : characterSheetFeedbackText
    setIsSubmittingCharacterSheetFeedback(true)
    setErrorMessage(null)
    setThreeActStructure(null)
    setStructureHistory([])
    setSceneList(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/character-sheet/${characterSheet.id}/request-changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsSubmittingCharacterSheetFeedback(false)
        return
      }

      setCharacterSheet(data)
      setShowCharacterSheetFeedbackForm(false)
      setCharacterSheetFeedbackText('')
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsSubmittingCharacterSheetFeedback(false)
  }

  async function handleGenerateStructureClick() {
    setIsGeneratingStructure(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/three-act-structure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pitchDeckId: pitchDeck.id }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsGeneratingStructure(false)
        return
      }

      setThreeActStructure(data)
      loadStructureHistory(pitchDeck.id)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsGeneratingStructure(false)
  }

  async function handleLockStructureClick() {
    setIsLockingStructure(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/three-act-structure/${threeActStructure.id}/lock`, {
        method: 'POST',
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsLockingStructure(false)
        return
      }

      setThreeActStructure(data)
      loadStructureHistory(pitchDeck.id)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsLockingStructure(false)
  }

  async function handleSubmitStructureFeedbackClick(overrideText) {
    const feedback = typeof overrideText === 'string' ? overrideText : structureFeedbackText
    setIsSubmittingStructureFeedback(true)
    setErrorMessage(null)
    setBitSheet(null)
    setSceneList(null)

    try {
      const response = await fetch(
        `${BACKEND_URL}/api/three-act-structure/${threeActStructure.id}/request-changes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ feedback }),
        }
      )
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsSubmittingStructureFeedback(false)
        return
      }

      setThreeActStructure(data)
      setShowStructureFeedbackForm(false)
      setStructureFeedbackText('')
      loadStructureHistory(pitchDeck.id)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsSubmittingStructureFeedback(false)
  }

  async function handleToggleVersionClick(id) {
    if (expandedVersionId === id) {
      setExpandedVersionId(null)
      setExpandedVersionContent(null)
      return
    }

    const response = await fetch(`${BACKEND_URL}/api/three-act-structure/${id}`)
    const data = await response.json()
    setExpandedVersionId(id)
    setExpandedVersionContent(data)
  }

  async function handleGenerateBitSheetClick() {
    setIsGeneratingBitSheet(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/bit-sheet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threeActStructureId: threeActStructure.id }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsGeneratingBitSheet(false)
        return
      }

      setBitSheet(data)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsGeneratingBitSheet(false)
  }

  async function handleApproveBitSheetClick() {
    setIsApprovingBitSheet(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/bit-sheet/${bitSheet.id}/approve`, {
        method: 'POST',
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsApprovingBitSheet(false)
        return
      }

      setBitSheet(data)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsApprovingBitSheet(false)
  }

  async function handleSubmitBitSheetFeedbackClick(overrideText) {
    const feedback = typeof overrideText === 'string' ? overrideText : bitSheetFeedbackText
    setIsSubmittingBitSheetFeedback(true)
    setErrorMessage(null)
    setSceneList(null)
    setScreenplayScenesByKey({})

    try {
      const response = await fetch(`${BACKEND_URL}/api/bit-sheet/${bitSheet.id}/request-changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsSubmittingBitSheetFeedback(false)
        return
      }

      setBitSheet(data)
      setShowBitSheetFeedbackForm(false)
      setBitSheetFeedbackText('')
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsSubmittingBitSheetFeedback(false)
  }

  async function handleGenerateSceneListClick() {
    setIsGeneratingSceneList(true)
    setErrorMessage(null)
    setScreenplayScenesByKey({})

    try {
      const response = await fetch(`${BACKEND_URL}/api/scene-list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bitSheetId: bitSheet.id }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsGeneratingSceneList(false)
        return
      }

      setSceneList(data)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsGeneratingSceneList(false)
  }

  async function handleApproveSceneListClick() {
    setIsApprovingSceneList(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/scene-list/${sceneList.id}/approve`, {
        method: 'POST',
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsApprovingSceneList(false)
        return
      }

      setSceneList(data)
      loadScreenplayScenes(data.id)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsApprovingSceneList(false)
  }

  async function handleSubmitSceneListFeedbackClick(overrideText) {
    const feedback = typeof overrideText === 'string' ? overrideText : sceneListFeedbackText
    setIsSubmittingSceneListFeedback(true)
    setErrorMessage(null)
    setScreenplayScenesByKey({})
    setShootSchedule(null)
    setCharacterAvailability({})
    setLocationAvailability({})

    try {
      const response = await fetch(`${BACKEND_URL}/api/scene-list/${sceneList.id}/request-changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsSubmittingSceneListFeedback(false)
        return
      }

      setSceneList(data)
      setShowSceneListFeedbackForm(false)
      setSceneListFeedbackText('')
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsSubmittingSceneListFeedback(false)
  }

  async function handleGenerateBreakdownClick() {
    setIsGeneratingBreakdown(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/script-breakdown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneListId: sceneList.id }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsGeneratingBreakdown(false)
        return
      }

      setScriptBreakdown(data)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsGeneratingBreakdown(false)
  }

  async function handleGenerateAdSheetClick() {
    setIsGeneratingAdSheet(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/generate-ad-sheet`, {
        method: 'POST',
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsGeneratingAdSheet(false)
        return
      }

      setScriptBreakdown(data)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsGeneratingAdSheet(false)
  }

  async function handleApproveBreakdownClick() {
    setIsApprovingBreakdown(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/approve`, {
        method: 'POST',
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsApprovingBreakdown(false)
        return
      }

      setScriptBreakdown(data)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsApprovingBreakdown(false)
  }

  async function handleSubmitBreakdownFeedbackClick(overrideText) {
    const feedback = typeof overrideText === 'string' ? overrideText : breakdownFeedbackText
    setIsSubmittingBreakdownFeedback(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/request-changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsSubmittingBreakdownFeedback(false)
        return
      }

      setScriptBreakdown(data)
      setShowBreakdownFeedbackForm(false)
      setBreakdownFeedbackText('')
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsSubmittingBreakdownFeedback(false)
  }

  async function handleReanalyzeCategoryClick(category) {
    setReanalyzingCategory(category)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/reanalyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setReanalyzingCategory(null)
        return
      }

      setScriptBreakdown(data)
      setEditingBreakdownCategory(null)
    } catch {
      setErrorMessage(t.genericError)
    }

    setReanalyzingCategory(null)
  }

  function blankBreakdownItem(category) {
    if (category === 'locationList') {
      return { location: { en: '', or: '' }, intExt: 'INT', sceneCount: 1, notes: { en: '', or: '' } }
    }
    if (category === 'costumes') {
      return { character: '', description: { en: '', or: '' } }
    }
    if (category === 'artistList') {
      return { label: '', notes: { en: '', or: '' }, age: 'Unspecified', gender: 'Unspecified' }
    }
    return { label: '', notes: { en: '', or: '' } }
  }

  function handleStartEditCategory(category) {
    setEditingBreakdownCategory(category)
    setBreakdownCategoryDraft(JSON.parse(JSON.stringify(scriptBreakdown[category] ?? [])))
  }

  function handleCancelEditCategory() {
    setEditingBreakdownCategory(null)
    setBreakdownCategoryDraft([])
  }

  function handleAddBreakdownDraftItem() {
    setBreakdownCategoryDraft([...breakdownCategoryDraft, blankBreakdownItem(editingBreakdownCategory)])
  }

  function handleRemoveBreakdownDraftItem(index) {
    setBreakdownCategoryDraft(breakdownCategoryDraft.filter((_, i) => i !== index))
  }

  function handleBreakdownDraftFieldChange(index, updater) {
    setBreakdownCategoryDraft(
      breakdownCategoryDraft.map((item, i) => (i === index ? updater(item) : item))
    )
  }

  // The link between a cast/location entry and its breakdown item is just a
  // plain string match (character_name), not a foreign key — so renaming an
  // item during edit would otherwise silently strand its already-confirmed
  // artist/location. Detects renames by comparing the old and new label at
  // each index (best-effort: only meaningful when items were edited in
  // place, not reordered/added/removed in the same save) and re-points the
  // matching crew_members rows to the new name.
  async function propagateBreakdownRenames(category, previousItems, nextItems) {
    const crewCategory = category === 'artistList' ? 'artist' : category === 'locationList' ? 'location' : null
    if (!crewCategory) return

    const getLabel = (item) => (category === 'artistList' ? item.label : item.location.en)
    const renames = []
    previousItems.forEach((prevItem, index) => {
      const nextItem = nextItems[index]
      if (!nextItem) return
      const oldName = getLabel(prevItem)
      const newName = getLabel(nextItem)
      if (oldName && newName && oldName !== newName) renames.push({ oldName, newName })
    })
    if (renames.length === 0) return

    for (const { oldName, newName } of renames) {
      await fetch(`${BACKEND_URL}/api/crew/rename-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneListId: sceneList.id, category: crewCategory, oldName, newName }),
      }).catch(() => {})
    }

    setCrewMembers((prev) =>
      prev.map((member) => {
        const rename = renames.find((r) => r.oldName === member.characterName && member.category === crewCategory)
        return rename ? { ...member, characterName: rename.newName } : member
      })
    )
  }

  async function handleSaveBreakdownEditsClick() {
    setIsSavingBreakdownEdits(true)
    setErrorMessage(null)

    const content = {
      artistList: scriptBreakdown.artistList,
      locationList: scriptBreakdown.locationList,
      props: scriptBreakdown.props,
      costumes: scriptBreakdown.costumes,
      art: scriptBreakdown.art,
      [editingBreakdownCategory]: breakdownCategoryDraft,
    }

    try {
      const response = await fetch(`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsSavingBreakdownEdits(false)
        return
      }

      await propagateBreakdownRenames(editingBreakdownCategory, scriptBreakdown[editingBreakdownCategory] ?? [], breakdownCategoryDraft)

      setScriptBreakdown(data)
      setEditingBreakdownCategory(null)
      setBreakdownCategoryDraft([])
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsSavingBreakdownEdits(false)
  }

  async function handleAddMissingCharacterClick() {
    if (!newCastCharacterName.trim()) return
    setIsAddingCastCharacter(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/add-character`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: newCastCharacterName.trim() }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsAddingCastCharacter(false)
        return
      }

      setScriptBreakdown(data)
      setNewCastCharacterName('')
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsAddingCastCharacter(false)
  }

  async function handleFindMissingCharactersClick() {
    setIsFindingMissingCharacters(true)
    setErrorMessage(null)
    setFoundMissingCharacters(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/find-missing-characters`, {
        method: 'POST',
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsFindingMissingCharacters(false)
        return
      }

      setScriptBreakdown(data)
      setFoundMissingCharacters(data.addedCharacters ?? [])
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsFindingMissingCharacters(false)
  }

  function renderBreakdownCategory(category, headingKey) {
    const items = scriptBreakdown[category] ?? []
    const isEditing = editingBreakdownCategory === category
    const isReanalyzing = reanalyzingCategory === category
    const isCategoryExpanded = Boolean(expandedBreakdownCategories[category])

    return (
      <div className="breakdown-category" key={category}>
        <div className="breakdown-category-header">
          <button className="breakdown-item-toggle breakdown-category-toggle" onClick={() => toggleBreakdownCategory(category)}>
            <span className={isCategoryExpanded ? 'breakdown-item-chevron expanded' : 'breakdown-item-chevron'}>▸</span>
            <h4>
              {t[headingKey]} <span className="breakdown-item-meta">({items.length})</span>
            </h4>
          </button>
          <div className="breakdown-category-actions">
            <a
              className="breakdown-pdf-link"
              href={`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/export?category=${category}&lang=${language}`}
            >
              {t.downloadPdfLabel}
            </a>
            <a
              className="breakdown-pdf-link"
              href={`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/export-excel?category=${category}&lang=${language}`}
            >
              {t.downloadExcelLabel}
            </a>
            {!isEditing && canAnalyzeScript && (
              <>
                <button
                  className="breakdown-action-button"
                  onClick={() => handleReanalyzeCategoryClick(category)}
                  disabled={reanalyzingCategory !== null}
                >
                  {isReanalyzing ? t.reanalyzingLabel : t.reanalyzeButton}
                </button>
                <button
                  className="breakdown-action-button"
                  onClick={() => handleStartEditCategory(category)}
                  disabled={reanalyzingCategory !== null}
                >
                  {t.editButton}
                </button>
              </>
            )}
          </div>
        </div>

        {!isEditing && isCategoryExpanded && items.length > 1 && (
          <button
            className="breakdown-action-button breakdown-expand-all-button"
            onClick={() => {
              const allKeys = items.map((_, index) => `${category}:${index}`)
              const allExpanded = allKeys.every((key) => expandedBreakdownItems[key])
              setExpandedBreakdownItems((prev) => {
                const next = { ...prev }
                allKeys.forEach((key) => {
                  next[key] = !allExpanded
                })
                return next
              })
            }}
          >
            {items.every((_, index) => expandedBreakdownItems[`${category}:${index}`]) ? t.collapseAllButton : t.expandAllButton}
          </button>
        )}

        {!isEditing &&
          isCategoryExpanded &&
          items.map((item, index) => {
            const itemKey = `${category}:${index}`
            const isExpanded = Boolean(expandedBreakdownItems[itemKey])
            const isCastFinalized =
              category === 'artistList' && crewMembers.some((m) => m.category === 'artist' && m.characterName === item.label)
            const isLocationFinalized =
              category === 'locationList' &&
              crewMembers.some((m) => m.category === 'location' && m.characterName === item.location.en)

            // Same wrapped/pending/in-progress classification as the Shoot
            // Schedule's Artist-Wise Summary (and its PDF) — cross-referenced
            // here too so a character's shoot status is visible right where
            // casting happens, not only on the separate schedule page.
            let shootStatus = null
            if (category === 'artistList' && shootSchedule?.artistSchedule && shootSchedule?.scheduleDays) {
              const entry = shootSchedule.artistSchedule.find((e) => e.character.toLowerCase() === item.label.toLowerCase())
              if (entry) {
                const completedByDayNumber = Object.fromEntries(shootSchedule.scheduleDays.map((d) => [d.dayNumber, Boolean(d.completed)]))
                const completedFlags = entry.days.map((d) => completedByDayNumber[d.dayNumber])
                shootStatus = completedFlags.every(Boolean) ? 'wrapped' : completedFlags.every((c) => !c) ? 'pending' : 'in-progress'
              }
            }

            return (
              <div key={index} className="breakdown-item">
                <button className="breakdown-item-toggle" onClick={() => toggleBreakdownItem(itemKey)}>
                  <span className={isExpanded ? 'breakdown-item-chevron expanded' : 'breakdown-item-chevron'}>▸</span>
                  {category === 'locationList' ? (
                    <>
                      <strong>{item.location[language]}</strong>{' '}
                      <span className="breakdown-item-meta">
                        ({item.intExt} — {item.sceneCount} {t.scenesLabel})
                      </span>
                      <span className={isLocationFinalized ? 'breakdown-item-chip finalized' : 'breakdown-item-chip pending'}>
                        {isLocationFinalized ? '✓' : '…'}
                      </span>
                    </>
                  ) : category === 'costumes' ? (
                    <strong>{item.character}</strong>
                  ) : category === 'artistList' ? (
                    <>
                      <strong className={shootStatus ? `artist-name-${shootStatus}` : ''}>{item.label}</strong>{' '}
                      <span className="breakdown-item-meta">
                        ({item.gender || t.unspecifiedLabel}, {item.age || t.unspecifiedLabel})
                      </span>
                      {shootStatus && (
                        <span className={`artist-schedule-status-chip ${shootStatus}`}>
                          {shootStatus === 'wrapped' ? t.artistStatusWrappedLabel : shootStatus === 'in-progress' ? t.artistStatusInProgressLabel : t.artistStatusPendingLabel}
                        </span>
                      )}
                      <span className={isCastFinalized ? 'breakdown-item-chip finalized' : 'breakdown-item-chip pending'}>
                        {isCastFinalized ? '✓' : '…'}
                      </span>
                    </>
                  ) : (
                    <strong>{item.label}</strong>
                  )}
                </button>

                {isExpanded && (
                  <>
                    <p>{category === 'costumes' ? item.description[language] : item.notes[language]}</p>

                    {category === 'artistList' && (
                      <InlineCastAttachment
                        category="artist"
                        linkKey={item.label}
                        members={crewMembers.filter((m) => m.category === 'artist' && m.characterName === item.label)}
                        onAdd={handleAddCrewMember}
                        onUpdate={handleUpdateCrewMember}
                        onDelete={handleDeleteCrewMember}
                        isAdding={isAddingCrew}
                        deletingId={crewDeletingId}
                        updatingId={crewUpdatingId}
                        t={t}
                        BACKEND_URL={BACKEND_URL}
                        canEdit={canEditProduction}
                        googleConnected={googleConnected}
                        googleContacts={googleContacts}
                        isLoadingGoogleContacts={isLoadingGoogleContacts}
                        onLoadGoogleContacts={loadGoogleContacts}
                        onAddFromContact={handleAddCrewMemberFromContact}
                        sceneListId={sceneList.id}
                        language={language}
                        projectTitle={projectTitle}
                      />
                    )}
                    {category === 'locationList' && (
                      <InlineCastAttachment
                        category="location"
                        linkKey={item.location.en}
                        members={crewMembers.filter((m) => m.category === 'location' && m.characterName === item.location.en)}
                        onAdd={handleAddCrewMember}
                        onUpdate={handleUpdateCrewMember}
                        onDelete={handleDeleteCrewMember}
                        isAdding={isAddingCrew}
                        deletingId={crewDeletingId}
                        updatingId={crewUpdatingId}
                        t={t}
                        BACKEND_URL={BACKEND_URL}
                        canEdit={canEditProduction}
                      />
                    )}
                  </>
                )}
              </div>
            )
          })}

        {!isEditing && isCategoryExpanded && category === 'artistList' && canEditProduction && (
          <div className="add-missing-character-form">
            <input
              type="text"
              placeholder={t.missingCharacterNamePlaceholder}
              value={newCastCharacterName}
              onChange={(e) => setNewCastCharacterName(e.target.value)}
            />
            <button
              className="breakdown-action-button"
              onClick={handleAddMissingCharacterClick}
              disabled={isAddingCastCharacter || !newCastCharacterName.trim()}
            >
              {isAddingCastCharacter ? t.addingCharacterLabel : t.addMissingCharacterButton}
            </button>
            {canAnalyzeScript && (
              <button
                className="breakdown-action-button"
                onClick={handleFindMissingCharactersClick}
                disabled={isFindingMissingCharacters}
                title={t.findMissingCharactersHint}
              >
                {isFindingMissingCharacters ? t.findingMissingCharactersLabel : t.findMissingCharactersButton}
              </button>
            )}
          </div>
        )}

        {!isEditing && isCategoryExpanded && category === 'artistList' && foundMissingCharacters !== null && (
          <p className="sidebar-section-note">
            {foundMissingCharacters.length > 0
              ? `${t.foundMissingCharactersLabel}: ${foundMissingCharacters.join(', ')}`
              : t.noMissingCharactersFoundLabel}
          </p>
        )}

        {isEditing && (
          <div className="breakdown-edit-list">
            {breakdownCategoryDraft.map((item, index) => (
              <div key={index} className="breakdown-edit-row">
                {category === 'locationList' ? (
                  <>
                    <div className="breakdown-edit-field-pair">
                      <input
                        type="text"
                        placeholder="Location (EN)"
                        value={item.location.en}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            location: { ...it.location, en: e.target.value },
                          }))
                        }
                      />
                      <input
                        type="text"
                        placeholder="ସ୍ଥାନ (OR)"
                        value={item.location.or}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            location: { ...it.location, or: e.target.value },
                          }))
                        }
                      />
                    </div>
                    <div className="breakdown-edit-field-pair">
                      <select
                        value={item.intExt}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({ ...it, intExt: e.target.value }))
                        }
                      >
                        <option value="INT">INT</option>
                        <option value="EXT">EXT</option>
                      </select>
                      <input
                        type="number"
                        min="1"
                        placeholder={t.sceneCountLabel}
                        value={item.sceneCount}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            sceneCount: Number(e.target.value) || 1,
                          }))
                        }
                      />
                    </div>
                    <div className="breakdown-edit-field-pair">
                      <textarea
                        placeholder="Notes (EN)"
                        value={item.notes.en}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            notes: { ...it.notes, en: e.target.value },
                          }))
                        }
                      />
                      <textarea
                        placeholder="ମନ୍ତବ୍ୟ (OR)"
                        value={item.notes.or}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            notes: { ...it.notes, or: e.target.value },
                          }))
                        }
                      />
                    </div>
                  </>
                ) : category === 'costumes' ? (
                  <>
                    <input
                      type="text"
                      placeholder="Character"
                      value={item.character}
                      onChange={(e) =>
                        handleBreakdownDraftFieldChange(index, (it) => ({ ...it, character: e.target.value }))
                      }
                    />
                    <div className="breakdown-edit-field-pair">
                      <textarea
                        placeholder="Description (EN)"
                        value={item.description.en}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            description: { ...it.description, en: e.target.value },
                          }))
                        }
                      />
                      <textarea
                        placeholder="ବିବରଣୀ (OR)"
                        value={item.description.or}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            description: { ...it.description, or: e.target.value },
                          }))
                        }
                      />
                    </div>
                  </>
                ) : category === 'artistList' ? (
                  <>
                    <input
                      type="text"
                      placeholder="Label"
                      value={item.label}
                      onChange={(e) =>
                        handleBreakdownDraftFieldChange(index, (it) => ({ ...it, label: e.target.value }))
                      }
                    />
                    <div className="breakdown-edit-field-pair">
                      <input
                        type="text"
                        placeholder={t.ageLabel}
                        value={item.age || ''}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({ ...it, age: e.target.value }))
                        }
                      />
                      <select
                        value={item.gender || 'Unspecified'}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({ ...it, gender: e.target.value }))
                        }
                      >
                        <option value="Male">{t.genderMaleLabel}</option>
                        <option value="Female">{t.genderFemaleLabel}</option>
                        <option value="Unspecified">{t.unspecifiedLabel}</option>
                      </select>
                    </div>
                    <div className="breakdown-edit-field-pair">
                      <textarea
                        placeholder="Notes (EN)"
                        value={item.notes.en}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            notes: { ...it.notes, en: e.target.value },
                          }))
                        }
                      />
                      <textarea
                        placeholder="ମନ୍ତବ୍ୟ (OR)"
                        value={item.notes.or}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            notes: { ...it.notes, or: e.target.value },
                          }))
                        }
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <input
                      type="text"
                      placeholder="Label"
                      value={item.label}
                      onChange={(e) =>
                        handleBreakdownDraftFieldChange(index, (it) => ({ ...it, label: e.target.value }))
                      }
                    />
                    <div className="breakdown-edit-field-pair">
                      <textarea
                        placeholder="Notes (EN)"
                        value={item.notes.en}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            notes: { ...it.notes, en: e.target.value },
                          }))
                        }
                      />
                      <textarea
                        placeholder="ମନ୍ତବ୍ୟ (OR)"
                        value={item.notes.or}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            notes: { ...it.notes, or: e.target.value },
                          }))
                        }
                      />
                    </div>
                  </>
                )}
                <button className="breakdown-remove-button" onClick={() => handleRemoveBreakdownDraftItem(index)}>
                  {t.removeItemButton}
                </button>
              </div>
            ))}

            <div className="breakdown-edit-controls">
              <button className="import-export-button" onClick={handleAddBreakdownDraftItem}>
                {t.addItemButton}
              </button>
              <button className="choose-button" onClick={handleSaveBreakdownEditsClick} disabled={isSavingBreakdownEdits}>
                {isSavingBreakdownEdits ? t.savingChangesLabel : t.saveChangesButton}
              </button>
              <button className="cancel-button" onClick={handleCancelEditCategory} disabled={isSavingBreakdownEdits}>
                {t.cancelEditButton}
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  async function handleGenerateScheduleClick() {
    setIsGeneratingSchedule(true)
    setErrorMessage(null)

    const scheduleCharacterNames = characterSheet?.characters?.map((c) => c.name) ?? sceneList.characterNames ?? []
    const availability = {
      characters: scheduleCharacterNames.map((name) => ({
        name,
        ...(characterAvailability[name] ?? { availableDates: '', unknown: false }),
      })),
      locations: extractUniqueLocations(sceneList).map((location) => ({
        location: location.en,
        ...(locationAvailability[location.en] ?? { availableDates: '', unknown: false }),
      })),
      startDate: scheduleStartDate,
    }

    try {
      const response = await fetch(`${BACKEND_URL}/api/shoot-schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sceneListId: sceneList.id,
          availability,
          targetDays: Number(scheduleTargetDays) || null,
          specialInstructions: scheduleSpecialInstructions,
        }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsGeneratingSchedule(false)
        return
      }

      setShootSchedule(data)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsGeneratingSchedule(false)
  }

  async function handleParseDayCompletionClick(day) {
    if (!dayCompletionReportText.trim()) return
    setIsParsingDayCompletion(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/shoot-schedule/${sceneList.id}/parse-day-completion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dayNumber: day.dayNumber, reportText: dayCompletionReportText }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsParsingDayCompletion(false)
        return
      }

      const selections = {}
      day.sceneRefs.forEach((_, index) => {
        selections[index] = data.completedIndexes.includes(index)
      })
      setShotSceneSelections(selections)
      setDayCompletionParseResult(data)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsParsingDayCompletion(false)
  }

  async function handleConfirmDayShotClick(day) {
    setIsRecordingShotDay(true)
    setErrorMessage(null)

    const shotSceneRefs = day.sceneRefs.filter((_, index) => shotSceneSelections[index] !== false)
    const notesWithCompletion = shotCompletionNote.trim()
      ? { en: [day.notes?.en, shotCompletionNote.trim()].filter(Boolean).join(' — '), or: day.notes?.or ?? '' }
      : day.notes

    try {
      const response = await fetch(`${BACKEND_URL}/api/shoot-schedule/${sceneList.id}/record-day`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ day: { ...day, sceneRefs: shotSceneRefs, notes: notesWithCompletion } }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsRecordingShotDay(false)
        return
      }

      setShootSchedule(data)
      setMarkingShotDayNumber(null)
      setShotSceneSelections({})
      setShotCompletionNote('')
      setDayCompletionReportText('')
      setDayCompletionParseResult(null)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsRecordingShotDay(false)
  }

  async function handleApproveScheduleClick() {
    setIsApprovingSchedule(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/shoot-schedule/${shootSchedule.id}/approve`, {
        method: 'POST',
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsApprovingSchedule(false)
        return
      }

      setShootSchedule(data)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsApprovingSchedule(false)
  }

  async function handleSubmitScheduleFeedbackClick(overrideText) {
    const feedback = typeof overrideText === 'string' ? overrideText : scheduleFeedbackText
    setIsSubmittingScheduleFeedback(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/shoot-schedule/${shootSchedule.id}/request-changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsSubmittingScheduleFeedback(false)
        return
      }

      setShootSchedule(data)
      setShowScheduleFeedbackForm(false)
      setScheduleFeedbackText('')
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsSubmittingScheduleFeedback(false)
  }

  async function handleImportScreenplayClick() {
    if (!importScreenplayText.trim()) return

    setIsImportingScreenplay(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/import-screenplay-for-production`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pastedText: importScreenplayText, format: buildFormatObject() }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsImportingScreenplay(false)
        return
      }

      setImportScreenplayText('')
      await loadProject(data.conceptId)
      loadProjectList()
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsImportingScreenplay(false)
  }

  async function handleReimportScreenplayClick() {
    if (!reimportScreenplayText.trim()) return

    setIsReimportingScreenplay(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/scene-lists/${sceneList.id}/reimport-screenplay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pastedText: reimportScreenplayText, format: buildFormatObject() }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsReimportingScreenplay(false)
        return
      }

      setSceneList(data.sceneList)
      if (data.breakdown) setScriptBreakdown(data.breakdown)
      setReimportResult(data)
      setReimportScreenplayText('')
      setShowReimportForm(false)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsReimportingScreenplay(false)
  }

  async function handleReimportScreenplayFileSelected(event) {
    const file = event.target.files[0]
    event.target.value = ''
    if (!file) return

    setIsReimportingScreenplay(true)
    setErrorMessage(null)

    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('format', JSON.stringify(buildFormatObject()))

      const response = await fetch(`${BACKEND_URL}/api/scene-lists/${sceneList.id}/reimport-screenplay/file`, {
        method: 'POST',
        body: formData,
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsReimportingScreenplay(false)
        return
      }

      setSceneList(data.sceneList)
      if (data.breakdown) setScriptBreakdown(data.breakdown)
      setReimportResult(data)
      setShowReimportForm(false)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsReimportingScreenplay(false)
  }

  async function handleImportScreenplayFileSelected(event) {
    const file = event.target.files[0]
    event.target.value = ''
    if (!file) return

    setIsImportingScreenplayFile(true)
    setErrorMessage(null)

    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('format', JSON.stringify(buildFormatObject()))

      const response = await fetch(`${BACKEND_URL}/api/import-screenplay-for-production/file`, {
        method: 'POST',
        body: formData,
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsImportingScreenplayFile(false)
        return
      }

      await loadProject(data.conceptId)
      loadProjectList()
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsImportingScreenplayFile(false)
  }

  async function handleWriteSceneClick(episodeIndex, sceneIndex) {
    const key = screenplayKey(episodeIndex, sceneIndex)
    setGeneratingScreenplayKey(key)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/screenplay/scene`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneListId: sceneList.id, episodeIndex, sceneIndex }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setGeneratingScreenplayKey(null)
        return
      }

      setScreenplayScenesByKey((prev) => ({ ...prev, [key]: data }))
    } catch {
      setErrorMessage(t.genericError)
    }

    setGeneratingScreenplayKey(null)
  }

  function handleToggleScreenplayFeedback(key) {
    setScreenplayFeedbackFormKey((prev) => (prev === key ? null : key))
  }

  function handleScreenplayFeedbackTextChange(key, value) {
    setScreenplayFeedbackTextByKey((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmitScreenplayFeedback(key, id) {
    setSubmittingScreenplayFeedbackKey(key)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/screenplay/scene/${id}/request-changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: screenplayFeedbackTextByKey[key] || '' }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setSubmittingScreenplayFeedbackKey(null)
        return
      }

      setScreenplayScenesByKey((prev) => ({ ...prev, [key]: data }))
      setScreenplayFeedbackFormKey(null)
      setScreenplayFeedbackTextByKey((prev) => ({ ...prev, [key]: '' }))
    } catch {
      setErrorMessage(t.genericError)
    }

    setSubmittingScreenplayFeedbackKey(null)
  }

  const sidebarProjectLabel = projectTitle
    ? projectTitle
    : pitchDeck
      ? pitchDeck.title[language]
      : concept
        ? concept.slice(0, 40) + (concept.length > 40 ? '…' : '')
        : t.sidebarNewProject

  function projectHistoryLabel(item) {
    if (item.title) return item.title
    return item.conceptText.slice(0, 40) + (item.conceptText.length > 40 ? '…' : '')
  }

  function handleStageClick(anchorId) {
    setIsSidebarOpen(false)
    document.getElementById(anchorId)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const stageIdea = pitchDeck ? 'done' : 'current'
  const stageSynopsis = pitchDeck?.status === 'approved' ? 'done' : pitchDeck ? 'current' : 'upcoming'
  const stageCharacters = characterSheet?.status === 'approved' ? 'done' : pitchDeck?.status === 'approved' ? 'current' : 'upcoming'
  const stageBitSheet =
    bitSheet?.status === 'approved'
      ? 'done'
      : threeActStructure?.status === 'locked' || characterSheet?.status === 'approved'
        ? 'current'
        : 'upcoming'
  const stageScreenplay = bitSheet?.status === 'approved' ? 'current' : 'upcoming'
  const stageProduction = sceneList?.status === 'approved' ? 'done' : 'current'
  const stageBreakdown =
    scriptBreakdown?.status === 'approved' ? 'done' : sceneList?.status === 'approved' ? 'current' : 'upcoming'
  const stageSchedule =
    shootSchedule?.status === 'approved' ? 'done' : scriptBreakdown?.status === 'approved' ? 'current' : 'upcoming'

  const isBarBusy =
    isLoading ||
    isSubmittingFeedback ||
    isSubmittingStructureFeedback ||
    isSubmittingBitSheetFeedback ||
    isSubmittingSceneListFeedback ||
    isSubmittingBreakdownFeedback ||
    isSubmittingScheduleFeedback ||
    isSubmittingCharacterSheetFeedback

  let barConfig
  if (activeAgent === 'production') {
    if (scriptBreakdown && scriptBreakdown.status !== 'approved') {
      barConfig = {
        stageKey: 'breakdown',
        value: reviseFeedback,
        onChange: setReviseFeedback,
        placeholder: t.reviseBreakdownPlaceholder,
        disabled: false,
        canSubmit: !isSubmittingBreakdownFeedback && reviseFeedback.trim().length > 0,
        onSubmit: () => {
          const text = reviseFeedback.trim()
          setReviseFeedback('')
          handleSubmitBreakdownFeedbackClick(text)
        },
      }
    } else if (shootSchedule && shootSchedule.status !== 'approved') {
      barConfig = {
        stageKey: 'schedule',
        value: reviseFeedback,
        onChange: setReviseFeedback,
        placeholder: t.reviseSchedulePlaceholder,
        disabled: false,
        canSubmit: !isSubmittingScheduleFeedback && reviseFeedback.trim().length > 0,
        onSubmit: () => {
          const text = reviseFeedback.trim()
          setReviseFeedback('')
          handleSubmitScheduleFeedbackClick(text)
        },
      }
    } else {
      barConfig = {
        stageKey: 'idle',
        value: '',
        onChange: () => {},
        placeholder: t.idlePlaceholder,
        disabled: true,
        canSubmit: false,
        onSubmit: () => {},
      }
    }
  } else if (!storylines?.length || projectType !== 'story') {
    barConfig = {
      stageKey: 'idea',
      value: concept,
      onChange: setConcept,
      placeholder: t.emptyGreeting,
      disabled: false,
      canSubmit: !isLoading && concept.trim().length > 0,
      onSubmit: handleGenerateClick,
    }
  } else if (pendingStoryline && !pitchDeck) {
    barConfig = {
      stageKey: 'awaiting-format',
      value: '',
      onChange: () => {},
      placeholder: t.awaitingFormatPlaceholder,
      disabled: true,
      canSubmit: false,
      onSubmit: () => {},
    }
  } else if (!pitchDeck) {
    // Also covers loading a project from History: pendingStoryline is transient UI-only
    // state that doesn't survive a reload, but if a pitch deck already exists we skip
    // straight past this "still picking a storyline" mode further down instead.
    barConfig = {
      stageKey: 'storylines',
      value: regenerateFeedback,
      onChange: setRegenerateFeedback,
      placeholder: t.regeneratePlaceholder,
      disabled: false,
      canSubmit: !isLoading,
      onSubmit: handleRegenerateStorylinesClick,
    }
  } else if (pitchDeck.status !== 'approved') {
    barConfig = {
      stageKey: 'pitch-deck',
      value: reviseFeedback,
      onChange: setReviseFeedback,
      placeholder: t.revisePitchDeckPlaceholder,
      disabled: false,
      canSubmit: !isSubmittingFeedback && reviseFeedback.trim().length > 0,
      onSubmit: () => {
        const text = reviseFeedback.trim()
        setReviseFeedback('')
        handleSubmitFeedbackClick(text)
      },
    }
  } else if (characterSheet && characterSheet.status !== 'approved') {
    barConfig = {
      stageKey: 'character-sheet',
      value: reviseFeedback,
      onChange: setReviseFeedback,
      placeholder: t.reviseCharacterSheetPlaceholder,
      disabled: false,
      canSubmit: !isSubmittingCharacterSheetFeedback && reviseFeedback.trim().length > 0,
      onSubmit: () => {
        const text = reviseFeedback.trim()
        setReviseFeedback('')
        handleSubmitCharacterSheetFeedbackClick(text)
      },
    }
  } else if (threeActStructure && threeActStructure.status !== 'locked') {
    barConfig = {
      stageKey: 'three-act',
      value: reviseFeedback,
      onChange: setReviseFeedback,
      placeholder: t.reviseThreeActPlaceholder,
      disabled: false,
      canSubmit: !isSubmittingStructureFeedback && reviseFeedback.trim().length > 0,
      onSubmit: () => {
        const text = reviseFeedback.trim()
        setReviseFeedback('')
        handleSubmitStructureFeedbackClick(text)
      },
    }
  } else if (bitSheet && bitSheet.status !== 'approved') {
    barConfig = {
      stageKey: 'bit-sheet',
      value: reviseFeedback,
      onChange: setReviseFeedback,
      placeholder: t.reviseBitSheetPlaceholder,
      disabled: false,
      canSubmit: !isSubmittingBitSheetFeedback && reviseFeedback.trim().length > 0,
      onSubmit: () => {
        const text = reviseFeedback.trim()
        setReviseFeedback('')
        handleSubmitBitSheetFeedbackClick(text)
      },
    }
  } else if (sceneList && sceneList.status !== 'approved') {
    barConfig = {
      stageKey: 'scene-list',
      value: reviseFeedback,
      onChange: setReviseFeedback,
      placeholder: t.reviseSceneListPlaceholder,
      disabled: false,
      canSubmit: !isSubmittingSceneListFeedback && reviseFeedback.trim().length > 0,
      onSubmit: () => {
        const text = reviseFeedback.trim()
        setReviseFeedback('')
        handleSubmitSceneListFeedbackClick(text)
      },
    }
  } else {
    barConfig = {
      stageKey: 'idle',
      value: '',
      onChange: () => {},
      placeholder: t.idlePlaceholder,
      disabled: true,
      canSubmit: false,
      onSubmit: () => {},
    }
  }

  if (currentUser === undefined) {
    return <div className="app-shell" />
  }

  if (currentUser === null) {
    return (
      <div className="login-screen">
        <form className="login-form" onSubmit={handleLoginSubmit}>
          <h1>{t.heading}</h1>
          <input
            type="text"
            placeholder={t.usernameLabel}
            value={loginUsername}
            onChange={(e) => setLoginUsername(e.target.value)}
            autoFocus
          />
          <input
            type="password"
            placeholder={t.passwordLabel}
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
          />
          {loginError && <p className="feedback-note">{loginError}</p>}
          <button
            type="submit"
            className="choose-button"
            disabled={isLoggingIn || !loginUsername.trim() || !loginPassword}
          >
            {isLoggingIn ? t.loggingInLabel : t.loginButton}
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <div className="mobile-topbar">
        <button className="mobile-menu-button" onClick={() => setIsSidebarOpen(true)} aria-label={t.openMenuLabel}>
          ☰
        </button>
        <span className="mobile-topbar-title">{t.heading}</span>
      </div>

      {isSidebarOpen && <div className="sidebar-overlay" onClick={() => setIsSidebarOpen(false)} />}

      <aside className={`sidebar ${isSidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-header">
          <span className="sidebar-logo">{ICONS.clapperboard}</span>
          <span className="sidebar-title">{t.heading}</span>
          <button className="sidebar-close-button" onClick={() => setIsSidebarOpen(false)} aria-label={t.closeMenuLabel}>
            ✕
          </button>
        </div>

        <div className="current-user-row">
          <span className="current-user-name">{currentUser.name}</span>
          <button className="logout-button" onClick={handleLogoutClick}>{t.logoutButton}</button>
        </div>

        {currentUser.role === 'admin' && (
          <div className="manage-users-panel">
            <button className="import-export-button" onClick={handleToggleManageUsers}>
              {t.manageUsersButton}
            </button>
            {showManageUsers && (
              <div className="manage-users-list">
                {users.map((u) => (
                  <div key={u.id} className="manage-users-row">
                    <span>
                      {u.name}{' '}
                      <span className="breakdown-item-meta">
                        ({u.username} — {u.role}{u.project_title ? ` — ${u.project_title}` : ''})
                      </span>
                    </span>
                    <button className="breakdown-action-button crew-member-remove" onClick={() => handleDeleteUserClick(u.id)}>
                      {t.removeCrewMemberButton}
                    </button>
                  </div>
                ))}
                <form className="crew-add-form" onSubmit={handleCreateUserSubmit}>
                  <input type="text" placeholder={t.crewNameLabel} value={newUserName} onChange={(e) => setNewUserName(e.target.value)} />
                  <input type="text" placeholder={t.usernameLabel} value={newUserUsername} onChange={(e) => setNewUserUsername(e.target.value)} />
                  <input type="password" placeholder={t.passwordLabel} value={newUserPassword} onChange={(e) => setNewUserPassword(e.target.value)} />
                  <select value={newUserRole} onChange={(e) => setNewUserRole(e.target.value)}>
                    <option value="production_manager">{t.roleProductionManager}</option>
                    <option value="director">{t.roleDirector}</option>
                    <option value="admin">{t.roleAdmin}</option>
                  </select>
                  {newUserRole !== 'admin' && (
                    <select value={newUserConceptId} onChange={(e) => setNewUserConceptId(e.target.value)}>
                      <option value="">{t.assignProjectPlaceholder}</option>
                      {projectHistory.map((p) => (
                        <option key={p.id} value={p.id}>{p.title || p.conceptText?.slice(0, 40) || `#${p.id}`}</option>
                      ))}
                    </select>
                  )}
                  <button
                    className="breakdown-action-button"
                    type="submit"
                    disabled={
                      isCreatingUser ||
                      !newUserName.trim() ||
                      !newUserUsername.trim() ||
                      !newUserPassword ||
                      (newUserRole !== 'admin' && !newUserConceptId)
                    }
                  >
                    {t.addCrewMemberButton}
                  </button>
                </form>
                {userManagementError && <p className="feedback-note">{userManagementError}</p>}
              </div>
            )}
          </div>
        )}

        {!isScopedToOneProject && (
          <button className="new-idea-button" onClick={handleNewIdeaClick}>
            <span className="new-idea-icon">{ICONS.lightbulb}</span>
            {activeAgent === 'production' ? t.newProductionButton : t.newIdeaButton}
          </button>
        )}

        <div className="import-export-row">
          {(currentUser.role === 'admin' || currentUser.role === 'production_manager') && (
            <button className="import-export-button" onClick={() => importFileInputRef.current?.click()}>
              <span className="import-export-icon">{ICONS.upload}</span>
              {t.importButtonLabel}
            </button>
          )}
          <button className="import-export-button" onClick={handleExportClick} disabled={!conceptId || isExportingProject}>
            <span className="import-export-icon">{ICONS.download}</span>
            {isExportingProject ? t.exportingProjectLabel : t.exportButtonLabel}
          </button>
        </div>
        <input
          type="file"
          accept="application/json"
          ref={importFileInputRef}
          onChange={handleImportFileSelected}
          style={{ display: 'none' }}
        />

        {googleContactsNotice && (
          <p className={googleContactsNotice === 'connected' ? 'runtime-summary' : 'feedback-note'}>
            {googleContactsNotice === 'connected' ? t.googleContactsConnectedNotice : t.googleContactsErrorNotice}
          </p>
        )}
        {canEditProduction && (googleConnected ? (
          <p className="sidebar-section-note">{t.googleContactsConnectedLabel}</p>
        ) : (
          <a className="import-export-button google-connect-button" href={`${BACKEND_URL}/api/auth/google`}>
            {t.connectGoogleContactsButton}
          </a>
        ))}

        <div className="sidebar-section">
          <h4 className="sidebar-section-title">{t.agentsSectionTitle}</h4>
          <div className="agent-list">
            {currentUser.role === 'admin' && (
              <button
                className={activeAgent === 'masterList' ? 'agent-header active' : 'agent-header'}
                onClick={() => { setActiveAgent('masterList'); setIsSidebarOpen(false); loadMasterProjectList() }}
              >
                <span className="agent-expand-icon">▸</span>
                {t.masterProjectListLabel}
              </button>
            )}
            {currentUser.role === 'admin' && (
              <button
                className={activeAgent === 'story' ? 'agent-header active' : 'agent-header'}
                onClick={() => { setActiveAgent('story'); setIsSidebarOpen(false) }}
              >
                <span className={activeAgent === 'story' ? 'agent-expand-icon expanded' : 'agent-expand-icon'}>▸</span>
                {t.storyAgentLabel}
              </button>
            )}
            {activeAgent === 'story' && currentUser.role === 'admin' && (
              <div className="stage-progress agent-substages">
                <button className={`stage-progress-item stage-${stageIdea}`} onClick={() => handleStageClick('stage-idea')}>
                  <span className="stage-progress-dot" />
                  {t.stageIdeaLabel}
                </button>
                <button className={`stage-progress-item stage-${stageSynopsis}`} onClick={() => handleStageClick('stage-synopsis')}>
                  <span className="stage-progress-dot" />
                  {t.stageSynopsisLabel}
                </button>
                <button className={`stage-progress-item stage-${stageCharacters}`} onClick={() => handleStageClick('stage-characters')}>
                  <span className="stage-progress-dot" />
                  {t.stageCharactersLabel}
                </button>
                <button className={`stage-progress-item stage-${stageBitSheet}`} onClick={() => handleStageClick('stage-bitsheet')}>
                  <span className="stage-progress-dot" />
                  {t.stageBitSheetLabel}
                </button>
                <button className={`stage-progress-item stage-${stageScreenplay}`} onClick={() => handleStageClick('stage-screenplay')}>
                  <span className="stage-progress-dot" />
                  {t.stageScreenplayLabel}
                </button>
              </div>
            )}

            <button
              className={activeAgent === 'production' ? 'agent-header active' : 'agent-header'}
              onClick={() => { setActiveAgent('production'); setIsSidebarOpen(false) }}
            >
              <span className={activeAgent === 'production' ? 'agent-expand-icon expanded' : 'agent-expand-icon'}>▸</span>
              {t.productionAgentLabel}
            </button>
            {activeAgent === 'production' && (
              <div className="stage-progress agent-substages">
                <button className={`stage-progress-item stage-${stageProduction}`} onClick={() => handleStageClick('stage-production')}>
                  <span className="stage-progress-dot" />
                  {t.stageProductionLabel}
                </button>
                <button className={`stage-progress-item stage-${stageBreakdown}`} onClick={() => handleStageClick('stage-breakdown')}>
                  <span className="stage-progress-dot" />
                  {t.stageBreakdownLabel}
                </button>
                <button className="stage-progress-item stage-upcoming" onClick={() => handleStageClick('stage-crew')}>
                  <span className="stage-progress-dot" />
                  {t.stageCrewLabel}
                </button>
                <button className={`stage-progress-item stage-${stageSchedule}`} onClick={() => handleStageClick('stage-schedule')}>
                  <span className="stage-progress-dot" />
                  {t.stageScheduleLabel}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="sidebar-section">
          <h4 className="sidebar-section-title">{t.sidebarHistoryLabel}</h4>
          <p className="sidebar-section-note">{t.sidebarHistoryNote}</p>
          {projectHistory.filter((item) => (item.projectType ?? 'story') === activeAgent).length === 0 && !(conceptId && projectType === activeAgent) ? (
            <div className="sidebar-history-item">{sidebarProjectLabel}</div>
          ) : (
            projectHistory.filter((item) => (item.projectType ?? 'story') === activeAgent).map((item) => {
              const isActive = item.id === conceptId
              return (
                <div key={item.id} className={isActive ? 'sidebar-history-row active' : 'sidebar-history-row'}>
                  <button
                    className="sidebar-history-item"
                    onClick={() => loadProject(item.id)}
                  >
                    {item.pinned && <span className="sidebar-history-pin-marker">{ICONS.pin}</span>}
                    {isActive ? sidebarProjectLabel : projectHistoryLabel(item)}
                  </button>
                  {isActive && (
                    <button
                      className="sidebar-history-icon-button"
                      onClick={handleRenameProjectClick}
                      title={t.renameIconTitle}
                    >
                      {ICONS.pencil}
                    </button>
                  )}
                  <button
                    className="sidebar-history-icon-button"
                    onClick={() => handlePinToggleClick(item)}
                    title={item.pinned ? t.unpinIconTitle : t.pinIconTitle}
                  >
                    {ICONS.pin}
                  </button>
                  {currentUser.role === 'admin' && (
                    <button
                      className="sidebar-history-icon-button"
                      onClick={() => handleDeleteProjectClick(item)}
                      title={t.deleteIconTitle}
                    >
                      {ICONS.trash}
                    </button>
                  )}
                </div>
              )
            })
          )}
        </div>

        <div className="sidebar-lang-toggle">
          <button
            className={language === 'en' ? 'lang-button active' : 'lang-button'}
            onClick={() => setLanguage('en')}
          >
            English
          </button>
          <button
            className={language === 'or' ? 'lang-button active' : 'lang-button'}
            onClick={() => setLanguage('or')}
          >
            ଓଡ଼ିଆ (Odia)
          </button>
        </div>
      </aside>

      <main className="chat-viewport">
    <div className="concept-page" id="stage-idea">
      {errorMessage && <div className="error-banner">{errorMessage}</div>}

      {activeAgent === 'masterList' && (
        <div className="three-act-structure" id="stage-master-list">
          <h2>{t.masterProjectListHeading}</h2>

          {isLoadingMasterList && <p className="sidebar-section-note">{t.loadingLabel}</p>}

          {!isLoadingMasterList && (
            <>
              <div className="master-list-section">
                <h4>{t.ongoingProjectsHeading}</h4>
                {masterProjectList.filter((p) => p.stage === 'ongoing').length === 0 && (
                  <p className="sidebar-section-note">{t.noProjectsInStageNote}</p>
                )}
                <div className="master-list-grid">
                  {masterProjectList.filter((p) => p.stage === 'ongoing').map((project) => (
                    <button key={project.id} className="master-list-card" onClick={() => handleOpenMasterProjectClick(project)}>
                      <strong>{project.title}</strong>
                      <span className="breakdown-item-meta">
                        {project.projectType === 'production' ? t.productionAgentLabel : t.storyAgentLabel}
                      </span>
                      <div className="master-list-assignments">
                        {project.assignedUsers.map((u, i) => (
                          <span key={i} className="master-list-assignment-badge">
                            {u.role === 'production_manager' ? t.adRoleLabel : t.directorRoleLabel}: {u.name}
                          </span>
                        ))}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="master-list-section">
                <h4>{t.inDevelopmentProjectsHeading}</h4>
                {masterProjectList.filter((p) => p.stage === 'in_development').length === 0 && (
                  <p className="sidebar-section-note">{t.noProjectsInStageNote}</p>
                )}
                <div className="master-list-grid">
                  {masterProjectList.filter((p) => p.stage === 'in_development').map((project) => (
                    <button key={project.id} className="master-list-card" onClick={() => handleOpenMasterProjectClick(project)}>
                      <strong>{project.title}</strong>
                      <span className="breakdown-item-meta">
                        {project.projectType === 'production' ? t.productionAgentLabel : t.storyAgentLabel}
                      </span>
                      <div className="master-list-assignments">
                        {project.assignedUsers.length === 0 && <span className="breakdown-item-meta">{t.noOneAssignedNote}</span>}
                        {project.assignedUsers.map((u, i) => (
                          <span key={i} className="master-list-assignment-badge">
                            {u.role === 'production_manager' ? t.adRoleLabel : t.directorRoleLabel}: {u.name}
                          </span>
                        ))}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {activeAgent === 'story' && (
      <>
      {!storylines && !(conceptId && projectType === 'story') && (
        <div className="empty-state">
          {startStage === 'idea' && (
            <div className="format-picker">
              <h4 className="format-picker-title">{t.formatQuestion}</h4>
              <div className="format-picker-row">
                <label className="format-radio">
                  <input
                    type="radio"
                    name="format"
                    value="film"
                    checked={formatType === 'film'}
                    onChange={() => setFormatType('film')}
                  />
                  {t.filmOption}
                </label>
                <label className="format-radio">
                  <input
                    type="radio"
                    name="format"
                    value="series"
                    checked={formatType === 'series'}
                    onChange={() => setFormatType('series')}
                  />
                  {t.seriesOption}
                </label>
              </div>

              {formatType === 'series' ? (
                <div className="episode-fields">
                  <label>
                    {t.episodeCountLabel}
                    <input
                      type="number"
                      min="1"
                      value={episodeCount}
                      onChange={(e) => setEpisodeCount(e.target.value)}
                    />
                  </label>
                  <label>
                    {t.episodeMinutesLabel}
                    <input
                      type="number"
                      min="1"
                      value={episodeMinutes}
                      onChange={(e) => setEpisodeMinutes(e.target.value)}
                    />
                  </label>
                </div>
              ) : (
                <div className="episode-fields">
                  <label>
                    {t.runtimeMinutesLabel}
                    <input
                      type="number"
                      min="1"
                      value={runtimeMinutes}
                      onChange={(e) => setRuntimeMinutes(e.target.value)}
                    />
                  </label>
                </div>
              )}
            </div>
          )}

          {startStage === 'idea' && !concept && <h1 className="empty-state-greeting">{t.emptyGreeting}</h1>}

          <div className="start-stage-tabs">
            <span className="start-stage-label">{t.startStageLabel}</span>
            {['idea', 'synopsis', 'bitsheet', 'scenelist'].map((stage) => (
              <button
                key={stage}
                className={startStage === stage ? 'start-stage-tab active' : 'start-stage-tab'}
                onClick={() => setStartStage(stage)}
              >
                {stage === 'idea'
                  ? t.startStageIdea
                  : stage === 'synopsis'
                    ? t.startStageSynopsis
                    : stage === 'bitsheet'
                      ? t.startStageBitSheet
                      : t.startStageSceneList}
              </button>
            ))}
          </div>

          {startStage !== 'idea' && (
            <div className="skip-ahead-form">
              <textarea
                className="skip-ahead-textarea"
                value={skipPastedText}
                onChange={(e) => setSkipPastedText(e.target.value)}
                placeholder={
                  startStage === 'synopsis'
                    ? t.skipPastePlaceholderSynopsis
                    : startStage === 'bitsheet'
                      ? t.skipPastePlaceholderBitSheet
                      : t.skipPastePlaceholderSceneList
                }
              />
              <div className="skip-ahead-controls">
                <label className="skip-ahead-runtime-label">
                  {t.skipRuntimeLabel}
                  <input
                    type="number"
                    min="1"
                    className="skip-ahead-runtime-input"
                    value={skipRuntimeMinutes}
                    onChange={(e) => setSkipRuntimeMinutes(e.target.value)}
                  />
                </label>
                <button
                  className="choose-button"
                  onClick={handleSkipAheadSubmit}
                  disabled={isSkippingAhead || !skipPastedText.trim()}
                >
                  {isSkippingAhead ? t.skipContinueButtonLoading : t.skipContinueButton}
                </button>
              </div>
              <p className="skip-ahead-quota-note">{t.skipQuotaNote}</p>
            </div>
          )}
        </div>
      )}

      {projectType === 'story' && (concept || storylines?.length > 0) && (
        <div className="ai-bubble">
          <p>{t.instruction}</p>
        </div>
      )}

      {storylines?.length > 0 && (pendingStoryline || !pitchDeck) && (
        <div className="concept-result">
          <strong>{t.storylineSuggestions}</strong>
          <div className="storyline-options-row">
            {storylines.map((storyline, index) => {
              const isChosen = pendingStoryline === storyline
              const isDimmed = pendingStoryline && !isChosen

              return (
                <div key={index} className={`storyline-card${isChosen ? ' locked' : ''}${isDimmed ? ' dimmed' : ''}`}>
                  <span className="storyline-option-label">{t.optionLabel(index + 1)}</span>
                  <h3>{storyline.title[language]}</h3>
                  <p><em>{storyline.logline[language]}</em></p>
                  <p>{storyline.summary[language]}</p>
                  {isChosen ? (
                    <span className="locked-badge">✓ {t.lockedBadgeLabel}</span>
                  ) : (
                    <button
                      className="choose-button"
                      onClick={() => handleChooseClick(storyline)}
                      disabled={!!pendingStoryline}
                    >
                      {t.chooseThisOne}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {isGeneratingPitchDeck && (
        <div className="ai-bubble">
          <p>{t.buildingPitchDeck}</p>
        </div>
      )}
      </>
      )}

      {(activeAgent === 'story'
        ? startStage === 'idea' || (conceptId && projectType === 'story')
        : (scriptBreakdown && scriptBreakdown.status !== 'approved') || (shootSchedule && shootSchedule.status !== 'approved')) && (
        <ChangesChatPanel
          t={t}
          historyKey={`${conceptId ?? 'new'}:${barConfig.stageKey}`}
          barConfig={barConfig}
          isBusy={isBarBusy}
        />
      )}

      {activeAgent === 'story' && (
      <>
      {pitchDeck && (
        <div className="pitch-deck" id="stage-synopsis">
          <span className="format-badge">{formatBadgeText(pitchDeck.format, t)}</span>
          <h2>{pitchDeck.title[language]}</h2>
          <p className="pitch-deck-logline"><em>{pitchDeck.logline[language]}</em></p>

          <h4>{t.premise}</h4>
          <p>{pitchDeck.premise[language]}</p>

          <h4>{t.toneGenre}</h4>
          <p>{pitchDeck.toneGenre[language]}</p>

          <h4>{t.targetAudience}</h4>
          <p>{pitchDeck.targetAudience[language]}</p>

          {pitchDeck.majorCharacters && pitchDeck.majorCharacters.length > 0 && (
            <div className="major-characters">
              <h4>{t.majorCharactersHeading}</h4>
              {pitchDeck.majorCharacters.map((character, index) => (
                <div key={index} className="character-card">
                  <strong>{character.name}</strong>
                  <p className="character-role"><em>{character.role[language]}</em></p>
                  <p><strong>{t.emotionalCoreLabel}:</strong> {character.emotionalCore[language]}</p>
                  <p><strong>{t.conflictLabel}:</strong> {character.conflict[language]}</p>
                </div>
              ))}
            </div>
          )}

          {pitchDeck.episodes && (
            <div className="episode-breakdown">
              <h4>{t.episodeBreakdown}</h4>
              {pitchDeck.episodes.map((episode, index) => (
                <div key={index} className="episode-card">
                  <strong>{t.episodeLabel} {index + 1}: {episode.title[language]}</strong>
                  <p>{episode.synopsis[language]}</p>
                </div>
              ))}
            </div>
          )}

          {pitchDeck.previousFeedback && (
            <p className="feedback-note">
              <strong>{t.changesRequestedBadge}</strong> "{pitchDeck.previousFeedback}"
            </p>
          )}

          <div className="approval-section">
            {pitchDeck.status === 'approved' ? (
              <span className="approved-badge">{t.approvedBadge}</span>
            ) : (
              <>
                <div className="approval-buttons">
                  <button className="approve-button" onClick={handleApproveClick} disabled={isApproving}>
                    {t.approveButton}
                  </button>
                  <button
                    className="cancel-button"
                    onClick={() => setShowFeedbackForm(!showFeedbackForm)}
                  >
                    {t.requestChangesButton}
                  </button>
                </div>

                {showFeedbackForm && (
                  <div className="feedback-form">
                    <textarea
                      className="feedback-textarea"
                      value={feedbackText}
                      onChange={(e) => setFeedbackText(e.target.value)}
                      placeholder={t.feedbackPlaceholder}
                    />
                    <button
                      className="choose-button"
                      onClick={handleSubmitFeedbackClick}
                      disabled={isSubmittingFeedback || !feedbackText.trim()}
                    >
                      {isSubmittingFeedback ? t.submittingFeedback : t.submitFeedback}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          <a
            className="export-button"
            href={`${BACKEND_URL}/api/pitch-deck/${pitchDeck.id}/export?lang=${language}`}
          >
            {t.exportAsPdf}
          </a>
        </div>
      )}

      {pitchDeck && pitchDeck.status === 'approved' && !characterSheet && (
        <button
          className="choose-button generate-structure-button"
          onClick={handleGenerateCharacterSheetClick}
          disabled={isGeneratingCharacterSheet}
        >
          {isGeneratingCharacterSheet ? t.generatingCharacterSheetLabel : t.generateCharacterSheetButton}
        </button>
      )}

      {characterSheet && (
        <div className="three-act-structure" id="stage-characters">
          <h2>{t.characterSheetHeading}</h2>

          <div className="character-sheet-list">
            {characterSheet.characters.map((character, index) => (
              <div key={index} className="character-sheet-card">
                <div className="character-sheet-card-header">
                  <strong>{character.name}</strong>
                  <span className={`archetype-badge archetype-${character.archetype}`}>
                    {t.archetypeLabels[character.archetype] ?? character.archetype}
                  </span>
                </div>
                <p className="character-role"><em>{character.role[language]}</em></p>
                {character.archetypeNote?.[language] && (
                  <p className="character-archetype-note">{character.archetypeNote[language]}</p>
                )}
                <p><strong>{t.wantLabel}:</strong> {character.want[language]}</p>
                <p><strong>{t.needLabel}:</strong> {character.need[language]}</p>
                <p><strong>{t.flawLabel}:</strong> {character.flaw[language]}</p>
                {character.virtues?.length > 0 && (
                  <p><strong>{t.virtuesLabel}:</strong> {character.virtues.map((v) => v[language]).join(', ')}</p>
                )}
                <p><strong>{t.innerConflictLabel}:</strong> {character.innerConflict[language]}</p>
                <p><strong>{t.outerConflictLabel}:</strong> {character.outerConflict[language]}</p>
                <p><strong>{t.arcLabel}:</strong> {character.arc[language]}</p>
                <p><strong>{t.introductionBeatLabel}:</strong> {character.introductionBeat[language]}</p>
                {character.heroLogline?.[language] && (
                  <p><strong>{t.heroLoglineLabel}:</strong> {character.heroLogline[language]}</p>
                )}
              </div>
            ))}
          </div>

          {characterSheet.previousFeedback && (
            <p className="feedback-note">
              <strong>{t.changesRequestedBadge}</strong> "{characterSheet.previousFeedback}"
            </p>
          )}

          <div className="approval-section">
            {characterSheet.status === 'approved' ? (
              <span className="approved-badge">{t.characterSheetApprovedBadge}</span>
            ) : (
              <>
                <div className="approval-buttons">
                  <button
                    className="approve-button"
                    onClick={handleApproveCharacterSheetClick}
                    disabled={isApprovingCharacterSheet}
                  >
                    {t.approveCharacterSheetButton}
                  </button>
                  <button
                    className="cancel-button"
                    onClick={() => setShowCharacterSheetFeedbackForm(!showCharacterSheetFeedbackForm)}
                  >
                    {t.requestChangesButton}
                  </button>
                </div>

                {showCharacterSheetFeedbackForm && (
                  <div className="feedback-form">
                    <textarea
                      className="feedback-textarea"
                      value={characterSheetFeedbackText}
                      onChange={(e) => setCharacterSheetFeedbackText(e.target.value)}
                      placeholder={t.characterSheetFeedbackPlaceholder}
                    />
                    <button
                      className="choose-button"
                      onClick={handleSubmitCharacterSheetFeedbackClick}
                      disabled={isSubmittingCharacterSheetFeedback || !characterSheetFeedbackText.trim()}
                    >
                      {isSubmittingCharacterSheetFeedback ? t.submittingFeedback : t.submitFeedback}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {characterSheet && characterSheet.status === 'approved' && !threeActStructure && (
        <button
          className="choose-button generate-structure-button"
          onClick={handleGenerateStructureClick}
          disabled={isGeneratingStructure}
        >
          {isGeneratingStructure ? t.generatingThreeAct : t.generateThreeAct}
        </button>
      )}

      {threeActStructure && (
        <div className="three-act-structure">
          <h2>{t.threeActHeading}</h2>

          {threeActStructure.controllingIdea && (
            <p className="controlling-idea">
              <strong>{t.controllingIdeaLabel}</strong> {threeActStructure.controllingIdea[language]}
            </p>
          )}

          <ActBlocks content={threeActStructure} t={t} language={language} />

          <EpisodeStructures
            episodeStructures={threeActStructure.episodeStructures}
            episodes={pitchDeck?.episodes}
            t={t}
            language={language}
          />

          {threeActStructure.previousFeedback && (
            <p className="feedback-note">
              <strong>{t.changesRequestedBadge}</strong> "{threeActStructure.previousFeedback}"
            </p>
          )}

          <div className="approval-section">
            {threeActStructure.status === 'locked' ? (
              <span className="approved-badge">{t.lockedBadge}</span>
            ) : (
              <>
                <div className="approval-buttons">
                  <button
                    className="approve-button"
                    onClick={handleLockStructureClick}
                    disabled={isLockingStructure}
                  >
                    {t.lockButton}
                  </button>
                  <button
                    className="cancel-button"
                    onClick={() => setShowStructureFeedbackForm(!showStructureFeedbackForm)}
                  >
                    {t.requestChangesButton}
                  </button>
                </div>

                {showStructureFeedbackForm && (
                  <div className="feedback-form">
                    <textarea
                      className="feedback-textarea"
                      value={structureFeedbackText}
                      onChange={(e) => setStructureFeedbackText(e.target.value)}
                      placeholder={t.structureFeedbackPlaceholder}
                    />
                    <button
                      className="choose-button"
                      onClick={handleSubmitStructureFeedbackClick}
                      disabled={isSubmittingStructureFeedback || !structureFeedbackText.trim()}
                    >
                      {isSubmittingStructureFeedback ? t.submittingFeedback : t.submitFeedback}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {structureHistory.length > 1 && (
            <div className="version-history">
              <h4>{t.versionHistoryHeading}</h4>
              {structureHistory.map((version, index) => {
                const statusLabel =
                  version.status === 'locked'
                    ? t.statusLocked
                    : version.status === 'changes_requested'
                      ? t.statusChangesRequested
                      : t.statusPending
                const isExpanded = expandedVersionId === version.id

                return (
                  <div key={version.id} className="version-row">
                    <div className="version-row-header">
                      <span>{t.versionLabel} {index + 1} — {statusLabel}</span>
                      <button className="cancel-button" onClick={() => handleToggleVersionClick(version.id)}>
                        {isExpanded ? t.hideButton : t.viewButton}
                      </button>
                    </div>

                    {version.feedback && (
                      <p className="feedback-note">
                        <strong>{t.feedbackGivenLabel}</strong> "{version.feedback}"
                      </p>
                    )}

                    {isExpanded && expandedVersionContent && (
                      <div className="version-detail">
                        {expandedVersionContent.controllingIdea && (
                          <p className="controlling-idea">
                            <strong>{t.controllingIdeaLabel}</strong> {expandedVersionContent.controllingIdea[language]}
                          </p>
                        )}
                        <ActBlocks content={expandedVersionContent} t={t} language={language} />
                        <EpisodeStructures
                          episodeStructures={expandedVersionContent.episodeStructures}
                          episodes={pitchDeck?.episodes}
                          t={t}
                          language={language}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {threeActStructure && threeActStructure.status === 'locked' && !bitSheet && (
        <button
          className="choose-button generate-structure-button"
          onClick={handleGenerateBitSheetClick}
          disabled={isGeneratingBitSheet}
        >
          {isGeneratingBitSheet ? t.generatingBitSheet : t.generateBitSheet}
        </button>
      )}

      {bitSheet && (
        <div className="three-act-structure" id="stage-bitsheet">
          <h2>{t.bitSheetHeading}</h2>

          <BitSheetView bitSheet={bitSheet} episodes={pitchDeck?.episodes} t={t} language={language} />

          {bitSheet.previousFeedback && (
            <p className="feedback-note">
              <strong>{t.changesRequestedBadge}</strong> "{bitSheet.previousFeedback}"
            </p>
          )}

          <div className="approval-section">
            {bitSheet.status === 'approved' ? (
              <span className="approved-badge">{t.bitSheetApprovedBadge}</span>
            ) : (
              <>
                <div className="approval-buttons">
                  <button
                    className="approve-button"
                    onClick={handleApproveBitSheetClick}
                    disabled={isApprovingBitSheet}
                  >
                    {t.approveBitSheetButton}
                  </button>
                  <button
                    className="cancel-button"
                    onClick={() => setShowBitSheetFeedbackForm(!showBitSheetFeedbackForm)}
                  >
                    {t.requestChangesButton}
                  </button>
                </div>

                {showBitSheetFeedbackForm && (
                  <div className="feedback-form">
                    <textarea
                      className="feedback-textarea"
                      value={bitSheetFeedbackText}
                      onChange={(e) => setBitSheetFeedbackText(e.target.value)}
                      placeholder={t.bitSheetFeedbackPlaceholder}
                    />
                    <button
                      className="choose-button"
                      onClick={handleSubmitBitSheetFeedbackClick}
                      disabled={isSubmittingBitSheetFeedback || !bitSheetFeedbackText.trim()}
                    >
                      {isSubmittingBitSheetFeedback ? t.submittingFeedback : t.submitFeedback}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {bitSheet && bitSheet.status === 'approved' && !sceneList && (
        <button
          className="choose-button generate-structure-button"
          onClick={handleGenerateSceneListClick}
          disabled={isGeneratingSceneList}
        >
          {isGeneratingSceneList ? t.generatingSceneList : t.generateSceneList}
        </button>
      )}

      {sceneList && projectType === 'story' && (
        <div className="three-act-structure" id="stage-screenplay">
          <h2>{t.sceneListHeading}</h2>

          <SceneListView
            sceneList={sceneList}
            episodes={pitchDeck?.episodes}
            t={t}
            language={language}
            screenplay={
              sceneList.status === 'approved'
                ? {
                    scenesByKey: screenplayScenesByKey,
                    generatingKey: generatingScreenplayKey,
                    feedbackFormKey: screenplayFeedbackFormKey,
                    feedbackTextByKey: screenplayFeedbackTextByKey,
                    submittingFeedbackKey: submittingScreenplayFeedbackKey,
                    onWriteScene: handleWriteSceneClick,
                    onToggleFeedback: handleToggleScreenplayFeedback,
                    onFeedbackTextChange: handleScreenplayFeedbackTextChange,
                    onSubmitFeedback: handleSubmitScreenplayFeedback,
                  }
                : undefined
            }
          />

          {sceneList.status === 'approved' &&
            (() => {
              const totalScenes = countScenesInList(sceneList)
              const draftedScenes = Object.keys(screenplayScenesByKey).length
              return totalScenes > 0 && draftedScenes < totalScenes ? (
                <p className="screenplay-progress">{t.screenplayProgressLabel(draftedScenes, totalScenes)}</p>
              ) : totalScenes > 0 ? (
                <p className="screenplay-complete-banner">{t.screenplayCompleteBanner}</p>
              ) : null
            })()}

          {sceneList.previousFeedback && (
            <p className="feedback-note">
              <strong>{t.changesRequestedBadge}</strong> "{sceneList.previousFeedback}"
            </p>
          )}

          <div className="approval-section">
            {sceneList.status === 'approved' ? (
              <span className="approved-badge">{t.sceneListApprovedBadge}</span>
            ) : (
              <>
                <div className="approval-buttons">
                  <button
                    className="approve-button"
                    onClick={handleApproveSceneListClick}
                    disabled={isApprovingSceneList}
                  >
                    {t.approveSceneListButton}
                  </button>
                  <button
                    className="cancel-button"
                    onClick={() => setShowSceneListFeedbackForm(!showSceneListFeedbackForm)}
                  >
                    {t.requestChangesButton}
                  </button>
                </div>

                {showSceneListFeedbackForm && (
                  <div className="feedback-form">
                    <textarea
                      className="feedback-textarea"
                      value={sceneListFeedbackText}
                      onChange={(e) => setSceneListFeedbackText(e.target.value)}
                      placeholder={t.sceneListFeedbackPlaceholder}
                    />
                    <button
                      className="choose-button"
                      onClick={handleSubmitSceneListFeedbackClick}
                      disabled={isSubmittingSceneListFeedback || !sceneListFeedbackText.trim()}
                    >
                      {isSubmittingSceneListFeedback ? t.submittingFeedback : t.submitFeedback}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
      </>
      )}

      {activeAgent === 'production' && (
        <div className="three-act-structure" id="stage-production">
          <h2>{t.productionHeading}</h2>

          {canReviewProduction && sceneList && (
            <DirectorOverviewPanel sceneListId={sceneList.id} t={t} BACKEND_URL={BACKEND_URL} />
          )}

          {!(sceneList && sceneList.status === 'approved') && !canAnalyzeScript && (
            <p className="sidebar-section-note">{t.waitingOnProductionManagerImportNotice}</p>
          )}

          {!(sceneList && sceneList.status === 'approved') && canAnalyzeScript && (
            <div className="skip-ahead-form">
              <p className="availability-form-intro">{t.importScreenplayIntro}</p>

              <div className="format-picker">
                <h4 className="format-picker-title">{t.formatQuestion}</h4>
                <div className="format-picker-row">
                  <label className="format-radio">
                    <input
                      type="radio"
                      name="import-format"
                      value="film"
                      checked={formatType === 'film'}
                      onChange={() => setFormatType('film')}
                    />
                    {t.filmOption}
                  </label>
                  <label className="format-radio">
                    <input
                      type="radio"
                      name="import-format"
                      value="series"
                      checked={formatType === 'series'}
                      onChange={() => setFormatType('series')}
                    />
                    {t.seriesOption}
                  </label>
                </div>

                {formatType === 'series' ? (
                  <div className="episode-fields">
                    <label>
                      {t.episodeCountLabel}
                      <input
                        type="number"
                        min="1"
                        value={episodeCount}
                        onChange={(e) => setEpisodeCount(e.target.value)}
                      />
                    </label>
                    <label>
                      {t.episodeMinutesLabel}
                      <input
                        type="number"
                        min="1"
                        value={episodeMinutes}
                        onChange={(e) => setEpisodeMinutes(e.target.value)}
                      />
                    </label>
                  </div>
                ) : (
                  <div className="episode-fields">
                    <label>
                      {t.runtimeMinutesLabel}
                      <input
                        type="number"
                        min="1"
                        value={runtimeMinutes}
                        onChange={(e) => setRuntimeMinutes(e.target.value)}
                      />
                    </label>
                  </div>
                )}
              </div>

              <button
                className="import-export-button screenplay-file-button"
                onClick={() => screenplayFileInputRef.current?.click()}
                disabled={isImportingScreenplayFile}
              >
                <span className="import-export-icon">{ICONS.upload}</span>
                {isImportingScreenplayFile ? t.importingScreenplayLabel : t.uploadScreenplayFileButton}
              </button>
              <input
                type="file"
                accept=".txt,.fountain,.pdf,.docx,.doc,.fdx,.scrite"
                ref={screenplayFileInputRef}
                onChange={handleImportScreenplayFileSelected}
                style={{ display: 'none' }}
              />
              <p className="screenplay-file-formats-note">{t.screenplayFileFormatsNote}</p>

              <p className="availability-form-intro">{t.importScreenplayOrPaste}</p>
              <textarea
                className="skip-ahead-textarea"
                value={importScreenplayText}
                onChange={(e) => setImportScreenplayText(e.target.value)}
                placeholder={t.importScreenplayPlaceholder}
              />
              <div className="skip-ahead-controls">
                <button
                  className="choose-button"
                  onClick={handleImportScreenplayClick}
                  disabled={isImportingScreenplay || !importScreenplayText.trim()}
                >
                  {isImportingScreenplay ? t.importingScreenplayLabel : t.importScreenplayButton}
                </button>
              </div>
            </div>
          )}

          {sceneList && sceneList.status === 'approved' && sceneList.sourceText != null && canAnalyzeScript && (
            <div className="reimport-screenplay-panel">
              {!showReimportForm ? (
                <button className="import-export-button" onClick={() => setShowReimportForm(true)}>
                  {t.reimportScreenplayButton}
                </button>
              ) : (
                <div className="skip-ahead-form">
                  <p className="availability-form-intro">{t.reimportScreenplayIntro}</p>

                  <div className="format-picker">
                    <h4 className="format-picker-title">{t.formatQuestion}</h4>
                    <div className="format-picker-row">
                      <label className="format-radio">
                        <input
                          type="radio"
                          name="reimport-format"
                          value="film"
                          checked={formatType === 'film'}
                          onChange={() => setFormatType('film')}
                        />
                        {t.filmOption}
                      </label>
                      <label className="format-radio">
                        <input
                          type="radio"
                          name="reimport-format"
                          value="series"
                          checked={formatType === 'series'}
                          onChange={() => setFormatType('series')}
                        />
                        {t.seriesOption}
                      </label>
                    </div>

                    {formatType === 'series' ? (
                      <div className="episode-fields">
                        <label>
                          {t.episodeCountLabel}
                          <input type="number" min="1" value={episodeCount} onChange={(e) => setEpisodeCount(e.target.value)} />
                        </label>
                        <label>
                          {t.episodeMinutesLabel}
                          <input type="number" min="1" value={episodeMinutes} onChange={(e) => setEpisodeMinutes(e.target.value)} />
                        </label>
                      </div>
                    ) : (
                      <div className="episode-fields">
                        <label>
                          {t.runtimeMinutesLabel}
                          <input type="number" min="1" value={runtimeMinutes} onChange={(e) => setRuntimeMinutes(e.target.value)} />
                        </label>
                      </div>
                    )}
                  </div>

                  <button
                    className="import-export-button screenplay-file-button"
                    onClick={() => reimportScreenplayFileInputRef.current?.click()}
                    disabled={isReimportingScreenplay}
                  >
                    <span className="import-export-icon">{ICONS.upload}</span>
                    {isReimportingScreenplay ? t.reimportingScreenplayLabel : t.uploadScreenplayFileButton}
                  </button>
                  <input
                    type="file"
                    accept=".txt,.fountain,.pdf,.docx,.doc,.fdx,.scrite"
                    ref={reimportScreenplayFileInputRef}
                    onChange={handleReimportScreenplayFileSelected}
                    style={{ display: 'none' }}
                  />
                  <p className="screenplay-file-formats-note">{t.screenplayFileFormatsNote}</p>
                  <p className="availability-form-intro">{t.importScreenplayOrPaste}</p>
                  <textarea
                    className="skip-ahead-textarea"
                    value={reimportScreenplayText}
                    onChange={(e) => setReimportScreenplayText(e.target.value)}
                    placeholder={t.importScreenplayPlaceholder}
                  />
                  <div className="skip-ahead-controls">
                    <button
                      className="choose-button"
                      onClick={handleReimportScreenplayClick}
                      disabled={isReimportingScreenplay || !reimportScreenplayText.trim()}
                    >
                      {isReimportingScreenplay ? t.reimportingScreenplayLabel : t.confirmReimportScreenplayButton}
                    </button>
                    <button
                      className="cancel-button"
                      onClick={() => { setShowReimportForm(false); setReimportScreenplayText('') }}
                      disabled={isReimportingScreenplay}
                    >
                      {t.cancelEditButton}
                    </button>
                  </div>
                </div>
              )}

              {reimportResult && (
                <div className="reimport-changes-summary">
                  <p><strong>{t.reimportChangesHeading}</strong></p>
                  {reimportResult.changes.addedScenes.length > 0 && (
                    <p>{t.reimportAddedScenesLabel}: {reimportResult.changes.addedScenes.join(', ')}</p>
                  )}
                  {reimportResult.changes.removedScenes.length > 0 && (
                    <p>{t.reimportRemovedScenesLabel}: {reimportResult.changes.removedScenes.join(', ')}</p>
                  )}
                  {reimportResult.changes.addedCharacters.length > 0 && (
                    <p>{t.reimportAddedCharactersLabel}: {reimportResult.changes.addedCharacters.join(', ')}</p>
                  )}
                  {reimportResult.changes.removedCharacters.length > 0 && (
                    <p className="feedback-note">{t.reimportRemovedCharactersLabel}: {reimportResult.changes.removedCharacters.join(', ')}</p>
                  )}
                  {reimportResult.changes.addedLocations.length > 0 && (
                    <p>{t.reimportAddedLocationsLabel}: {reimportResult.changes.addedLocations.join(', ')}</p>
                  )}
                  {reimportResult.changes.removedLocations.length > 0 && (
                    <p className="feedback-note">{t.reimportRemovedLocationsLabel}: {reimportResult.changes.removedLocations.join(', ')}</p>
                  )}
                  {reimportResult.shootScheduleMayNeedRegeneration && (
                    <p className="feedback-note">{t.reimportShootScheduleWarning}</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {activeAgent === 'production' && sceneList && sceneList.status === 'approved' && (
        <div className="three-act-structure" id="stage-breakdown">
          <h2>{t.scriptBreakdownHeading}</h2>

          {!scriptBreakdown && (
            <button
              className="choose-button generate-structure-button"
              onClick={handleGenerateBreakdownClick}
              disabled={isGeneratingBreakdown}
            >
              {isGeneratingBreakdown ? t.generatingBreakdownLabel : t.generateBreakdownButton}
            </button>
          )}

          {scriptBreakdown && (
            <>
              <div className="ad-sheet-panel">
                {canEditProduction && (
                  <button
                    className="breakdown-action-button"
                    onClick={handleGenerateAdSheetClick}
                    disabled={isGeneratingAdSheet}
                  >
                    {isGeneratingAdSheet ? t.generatingAdSheetLabel : t.generateAdSheetButton}
                  </button>
                )}
                {scriptBreakdown.adSheet && (
                  <a
                    className="breakdown-pdf-link"
                    href={`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/export-ad-sheet?lang=${language}`}
                  >
                    {t.downloadAdSheetLabel}
                  </a>
                )}
              </div>

              {renderBreakdownCategory('artistList', 'artistListHeading')}
              {renderBreakdownCategory('locationList', 'locationListHeading')}
              {renderBreakdownCategory('props', 'propsHeading')}
              {renderBreakdownCategory('costumes', 'costumesHeading')}
              {renderBreakdownCategory('art', 'artHeading')}

              {scriptBreakdown.previousFeedback && (
                <p className="feedback-note">
                  <strong>{t.changesRequestedBadge}</strong> "{scriptBreakdown.previousFeedback}"
                </p>
              )}

              {(canReviewProduction || scriptBreakdown.status === 'approved') && (
                <div className="approval-section">
                  {scriptBreakdown.status === 'approved' ? (
                    <span className="approved-badge">{t.breakdownApprovedBadge}</span>
                  ) : (
                    <>
                      <div className="approval-buttons">
                        <button
                          className="approve-button"
                          onClick={handleApproveBreakdownClick}
                          disabled={isApprovingBreakdown}
                        >
                          {t.approveBreakdownButton}
                        </button>
                        <button
                          className="cancel-button"
                          onClick={() => setShowBreakdownFeedbackForm(!showBreakdownFeedbackForm)}
                        >
                          {t.requestChangesButton}
                        </button>
                      </div>

                      {showBreakdownFeedbackForm && (
                        <div className="feedback-form">
                          <textarea
                            className="feedback-textarea"
                            value={breakdownFeedbackText}
                            onChange={(e) => setBreakdownFeedbackText(e.target.value)}
                            placeholder={t.breakdownFeedbackPlaceholder}
                          />
                          <button
                            className="choose-button"
                            onClick={handleSubmitBreakdownFeedbackClick}
                            disabled={isSubmittingBreakdownFeedback || !breakdownFeedbackText.trim()}
                          >
                            {isSubmittingBreakdownFeedback ? t.submittingFeedback : t.submitFeedback}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {activeAgent === 'production' && sceneList && (
        <div className="three-act-structure" id="stage-crew">
          <h2>{t.crewHeading}</h2>
          <a
            className="breakdown-pdf-link"
            href={`${BACKEND_URL}/api/crew/export-excel?sceneListId=${sceneList.id}&lang=${language}`}
          >
            {t.downloadAllCrewExcelLabel}
          </a>

          <CrewSection
            category="artist"
            heading={t.castSectionHeading}
            members={crewMembers.filter((m) => m.category === 'artist')}
            characterOptions={
              scriptBreakdown?.artistList
                ? scriptBreakdown.artistList
                    .map((item) => item.label)
                    // Only characters that don't already have a confirmed
                    // artist attached — once cast (from here or from the
                    // Script Breakdown page itself, same underlying data),
                    // they drop out of the "still needs casting" picker
                    // instead of being asked for again.
                    .filter((label) => !crewMembers.some((m) => m.category === 'artist' && m.characterName === label))
                : null
            }
            onAdd={handleAddCrewMember}
            onUpdate={handleUpdateCrewMember}
            onDelete={handleDeleteCrewMember}
            isAdding={isAddingCrew}
            deletingId={crewDeletingId}
            updatingId={crewUpdatingId}
            t={t}
            BACKEND_URL={BACKEND_URL}
            canEdit={canEditProduction}
          />
          <CrewSection
            category="art_department"
            heading={t.artDepartmentHeading}
            members={crewMembers.filter((m) => m.category === 'art_department')}
            characterOptions={null}
            onAdd={handleAddCrewMember}
            onUpdate={handleUpdateCrewMember}
            onDelete={handleDeleteCrewMember}
            isAdding={isAddingCrew}
            deletingId={crewDeletingId}
            updatingId={crewUpdatingId}
            t={t}
            BACKEND_URL={BACKEND_URL}
            canEdit={canEditProduction}
          />
          <CrewSection
            category="costume_department"
            heading={t.costumeDepartmentHeading}
            members={crewMembers.filter((m) => m.category === 'costume_department')}
            characterOptions={null}
            onAdd={handleAddCrewMember}
            onUpdate={handleUpdateCrewMember}
            onDelete={handleDeleteCrewMember}
            isAdding={isAddingCrew}
            deletingId={crewDeletingId}
            updatingId={crewUpdatingId}
            t={t}
            BACKEND_URL={BACKEND_URL}
            canEdit={canEditProduction}
          />
          <CrewSection
            category="crew"
            heading={t.masterCrewHeading}
            members={crewMembers.filter((m) => m.category === 'crew')}
            characterOptions={null}
            onAdd={handleAddCrewMember}
            onUpdate={handleUpdateCrewMember}
            onDelete={handleDeleteCrewMember}
            isAdding={isAddingCrew}
            deletingId={crewDeletingId}
            updatingId={crewUpdatingId}
            t={t}
            BACKEND_URL={BACKEND_URL}
            canEdit={canEditProduction}
          />
        </div>
      )}

      {activeAgent === 'production' && scriptBreakdown && scriptBreakdown.status === 'approved' && (
        <div className="three-act-structure" id="stage-schedule">
          <h2>{t.shootScheduleHeading}</h2>

          {!shootSchedule && canEditProduction && (
            <div className="availability-form">
              <p className="availability-form-intro">{t.scheduleSetupIntro}</p>

              <div className="schedule-setup-row">
                <label className="schedule-setup-field">
                  {t.tentativeScheduleDateLabel}
                  <input
                    type="date"
                    className="schedule-setup-input"
                    value={scheduleStartDate}
                    onChange={(e) => setScheduleStartDate(e.target.value)}
                  />
                </label>
                <label className="schedule-setup-field">
                  {t.scheduleTargetDaysLabel}
                  <input
                    type="number"
                    min="1"
                    className="schedule-setup-input"
                    value={scheduleTargetDays}
                    onChange={(e) => setScheduleTargetDays(e.target.value)}
                  />
                </label>
              </div>

              <label className="schedule-setup-field schedule-setup-field-wide">
                {t.scheduleSpecialInstructionsLabel}
                <textarea
                  className="skip-ahead-textarea"
                  value={scheduleSpecialInstructions}
                  onChange={(e) => setScheduleSpecialInstructions(e.target.value)}
                  placeholder={t.scheduleSpecialInstructionsPlaceholder}
                />
              </label>

              <p className="availability-form-intro">{t.availabilityFormIntro}</p>

              <h4>{t.characterAvailabilityHeading}</h4>
              {(characterSheet?.characters?.map((c) => c.name) ?? sceneList.characterNames ?? []).map((characterName) => {
                const entry = characterAvailability[characterName] ?? { availableDates: '', unknown: false }
                return (
                  <div key={characterName} className="availability-row">
                    <span className="availability-row-name">{characterName}</span>
                    <input
                      type="text"
                      className="availability-dates-input"
                      value={entry.availableDates}
                      disabled={entry.unknown}
                      placeholder={t.availableDatesPlaceholder}
                      onChange={(e) =>
                        setCharacterAvailability({
                          ...characterAvailability,
                          [characterName]: { ...entry, availableDates: e.target.value },
                        })
                      }
                    />
                    <label className="availability-unknown-label">
                      <input
                        type="checkbox"
                        checked={entry.unknown}
                        onChange={(e) =>
                          setCharacterAvailability({
                            ...characterAvailability,
                            [characterName]: { ...entry, unknown: e.target.checked },
                          })
                        }
                      />
                      {t.unknownEstimateLabel}
                    </label>
                  </div>
                )
              })}

              <h4>{t.locationAvailabilityHeading}</h4>
              {extractUniqueLocations(sceneList).map((location) => {
                const entry = locationAvailability[location.en] ?? { availableDates: '', unknown: false }
                return (
                  <div key={location.en} className="availability-row">
                    <span className="availability-row-name">{location[language]}</span>
                    <input
                      type="text"
                      className="availability-dates-input"
                      value={entry.availableDates}
                      disabled={entry.unknown}
                      placeholder={t.availableDatesPlaceholder}
                      onChange={(e) =>
                        setLocationAvailability({
                          ...locationAvailability,
                          [location.en]: { ...entry, availableDates: e.target.value },
                        })
                      }
                    />
                    <label className="availability-unknown-label">
                      <input
                        type="checkbox"
                        checked={entry.unknown}
                        onChange={(e) =>
                          setLocationAvailability({
                            ...locationAvailability,
                            [location.en]: { ...entry, unknown: e.target.checked },
                          })
                        }
                      />
                      {t.unknownEstimateLabel}
                    </label>
                  </div>
                )
              })}

              <button
                className="choose-button generate-structure-button"
                onClick={handleGenerateScheduleClick}
                disabled={isGeneratingSchedule}
              >
                {isGeneratingSchedule ? t.generatingScheduleLabel : t.generateScheduleButton}
              </button>
            </div>
          )}

          {!shootSchedule && !canEditProduction && (
            <p className="sidebar-section-note">{t.waitingOnProductionManagerNotice}</p>
          )}

          {shootSchedule && (
            <>
              {shootSchedule.conflicts?.length > 0 && (
                <div className="schedule-conflicts">
                  <h4>{t.conflictsHeading}</h4>
                  {shootSchedule.conflicts.map((conflict, index) => (
                    <p key={index} className="feedback-note">{conflict[language]}</p>
                  ))}
                </div>
              )}

              {shootSchedule.scheduleDays.length > 1 && (
                <button
                  className="breakdown-action-button breakdown-expand-all-button"
                  onClick={() => {
                    const allExpanded = shootSchedule.scheduleDays.every((day) => expandedScheduleDays[day.dayNumber])
                    setExpandedScheduleDays((prev) => {
                      const next = { ...prev }
                      shootSchedule.scheduleDays.forEach((day) => {
                        next[day.dayNumber] = !allExpanded
                      })
                      return next
                    })
                  }}
                >
                  {shootSchedule.scheduleDays.every((day) => expandedScheduleDays[day.dayNumber]) ? t.collapseAllButton : t.expandAllButton}
                </button>
              )}

              <div className="schedule-days">
                {shootSchedule.scheduleDays.map((day) => {
                  const isDayExpanded = Boolean(expandedScheduleDays[day.dayNumber])
                  return (
                  <div key={day.dayNumber} className={day.completed ? 'schedule-day-card schedule-day-completed' : 'schedule-day-card'}>
                    <button className="breakdown-item-toggle" onClick={() => toggleScheduleDay(day.dayNumber)}>
                      <span className={isDayExpanded ? 'breakdown-item-chevron expanded' : 'breakdown-item-chevron'}>▸</span>
                      <strong>
                        {t.shootDayLabel} {day.dayNumber} — {day.location[language]}
                        {' '}
                        <span className="breakdown-item-meta">
                          ({day.sceneRefs.length} {t.scenesLabel})
                        </span>
                        {day.completed && <span className="schedule-day-completed-badge"> ✓ {t.shootDayCompletedLabel}</span>}
                      </strong>
                    </button>

                    {isDayExpanded && (
                      <>
                        <ul className="schedule-day-scenes">
                          {day.sceneRefs.map((ref, index) => {
                            const scene = lookupScene(sceneList, ref)
                            if (!scene) return null
                            const isMarking = markingShotDayNumber === day.dayNumber
                            return (
                              <li key={index}>
                                {isMarking && (
                                  <input
                                    type="checkbox"
                                    checked={shotSceneSelections[index] !== false}
                                    onChange={(e) =>
                                      setShotSceneSelections((prev) => ({ ...prev, [index]: e.target.checked }))
                                    }
                                  />
                                )}
                                {typeof ref.episodeIndex === 'number' ? `${t.episodeLabel} ${ref.episodeIndex + 1}, ` : ''}
                                {t.sceneLabel} {scene.sceneNumber ? cleanSceneNumber(scene.sceneNumber) : ref.sceneIndex + 1}: {scene.oneLiner[language]}
                                {(() => {
                                  const sceneCast = lookupSceneCast(sceneList, scriptBreakdown?.adSheet, ref)
                                  return sceneCast?.length > 0 ? (
                                    <span className="schedule-scene-meta"> — {t.castCalledLabel}: {sceneCast.join(', ')}</span>
                                  ) : null
                                })()}
                                {(ref.costume || ref.properties) && (
                                  <span className="schedule-scene-meta">
                                    {ref.costume && ` — ${t.costumeLabel}: ${ref.costume}`}
                                    {ref.properties && ` — ${t.propertiesLabel}: ${ref.properties}`}
                                  </span>
                                )}
                                {ref.adRemark && <p className="feedback-note schedule-scene-ad-remark">{t.adRemarkLabel}: {ref.adRemark}</p>}
                              </li>
                            )
                          })}
                        </ul>
                        {day.charactersNeeded?.length > 0 && (
                          <p className="schedule-day-cast">
                            <strong>{t.castCalledLabel}:</strong> {day.charactersNeeded.join(', ')}
                          </p>
                        )}
                        <p className="schedule-day-notes">{day.notes[language]}</p>
                        {canEditProduction && !day.completed && (
                          markingShotDayNumber === day.dayNumber ? (
                            <div className="skip-ahead-controls schedule-mark-shot-controls">
                              <p className="availability-form-intro">{t.dayCompletionReportIntro}</p>
                              <textarea
                                className="skip-ahead-textarea"
                                value={dayCompletionReportText}
                                onChange={(e) => setDayCompletionReportText(e.target.value)}
                                placeholder={t.dayCompletionReportPlaceholder}
                              />
                              <div className="skip-ahead-controls">
                                <button
                                  className="import-export-button"
                                  onClick={() => handleParseDayCompletionClick(day)}
                                  disabled={isParsingDayCompletion || !dayCompletionReportText.trim()}
                                >
                                  {isParsingDayCompletion ? t.parsingDayCompletionLabel : t.interpretReportButton}
                                </button>
                              </div>

                              {dayCompletionParseResult && (
                                <div className="reimport-changes-summary">
                                  <p><strong>{t.interpretedAsHeading}</strong></p>
                                  <p>✅ {t.completedLabel} ({dayCompletionParseResult.completed.length}): {dayCompletionParseResult.completed.map((c) => c.label.split(':')[0]).join(', ')}</p>
                                  <p>🔲 {t.movesToNextDayLabel} ({dayCompletionParseResult.notCompleted.length}): {dayCompletionParseResult.notCompleted.map((c) => c.label.split(':')[0]).join(', ') || t.noneLabel}</p>
                                  <p className="sidebar-section-note">{t.reviewCheckboxesNote}</p>
                                </div>
                              )}

                              <textarea
                                className="skip-ahead-textarea"
                                value={shotCompletionNote}
                                onChange={(e) => setShotCompletionNote(e.target.value)}
                                placeholder={t.completionNotePlaceholder}
                              />
                              <div className="skip-ahead-controls">
                                <button
                                  className="choose-button"
                                  onClick={() => handleConfirmDayShotClick(day)}
                                  disabled={isRecordingShotDay}
                                >
                                  {isRecordingShotDay ? t.recordingShotDayLabel : t.confirmShotScenesButton}
                                </button>
                                <button
                                  className="cancel-button"
                                  onClick={() => {
                                    setMarkingShotDayNumber(null)
                                    setShotCompletionNote('')
                                    setDayCompletionReportText('')
                                    setDayCompletionParseResult(null)
                                  }}
                                >
                                  {t.cancelEditButton}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              className="breakdown-action-button"
                              onClick={() => { setMarkingShotDayNumber(day.dayNumber); setShotSceneSelections({}) }}
                            >
                              {t.markDayShotButton}
                            </button>
                          )
                        )}
                      </>
                    )}
                  </div>
                  )
                })}
              </div>

              {shootSchedule.artistSchedule?.length > 0 && (
                <div className="artist-schedule-summary">
                  <button className="breakdown-item-toggle" onClick={() => setIsArtistScheduleExpanded(!isArtistScheduleExpanded)}>
                    <span className={isArtistScheduleExpanded ? 'breakdown-item-chevron expanded' : 'breakdown-item-chevron'}>▸</span>
                    <h4>
                      {t.artistScheduleHeading} <span className="breakdown-item-meta">({shootSchedule.artistSchedule.length})</span>
                    </h4>
                  </button>
                  {isArtistScheduleExpanded &&
                    (() => {
                      const completedByDayNumber = Object.fromEntries(
                        shootSchedule.scheduleDays.map((d) => [d.dayNumber, Boolean(d.completed)])
                      )
                      return shootSchedule.artistSchedule.map((entry) => {
                        const completedFlags = entry.days.map((d) => completedByDayNumber[d.dayNumber])
                        const allDone = completedFlags.every(Boolean)
                        const noneDone = completedFlags.every((c) => !c)
                        const statusClass = allDone ? 'wrapped' : noneDone ? 'pending' : 'in-progress'
                        const statusLabel = allDone ? t.artistStatusWrappedLabel : noneDone ? t.artistStatusPendingLabel : t.artistStatusInProgressLabel
                        return (
                          <p key={entry.character} className={`artist-schedule-row ${statusClass}`}>
                            <span className={`artist-schedule-status-chip ${statusClass}`}>{statusLabel}</span>{' '}
                            <strong>{entry.character}</strong> — {t.totalDaysLabel}: {entry.totalDays} (
                            {entry.days
                              .map((d) => `${t.shootDayLabel} ${d.dayNumber}${d.date ? ` (${d.date})` : ''}${completedByDayNumber[d.dayNumber] ? ' ✓' : ''}`)
                              .join(', ')}
                            )
                          </p>
                        )
                      })
                    })()}
                </div>
              )}

              {shootSchedule.previousFeedback && (
                <p className="feedback-note">
                  <strong>{t.changesRequestedBadge}</strong> "{shootSchedule.previousFeedback}"
                </p>
              )}

              {(canReviewProduction || shootSchedule.status === 'approved') && (
                <div className="approval-section">
                  {shootSchedule.status === 'approved' ? (
                    <span className="approved-badge">{t.scheduleApprovedBadge}</span>
                  ) : (
                    <>
                      <div className="approval-buttons">
                        <button
                          className="approve-button"
                          onClick={handleApproveScheduleClick}
                          disabled={isApprovingSchedule}
                        >
                          {t.approveScheduleButton}
                        </button>
                        <button
                          className="cancel-button"
                          onClick={() => setShowScheduleFeedbackForm(!showScheduleFeedbackForm)}
                        >
                          {t.requestChangesButton}
                        </button>
                      </div>

                      {showScheduleFeedbackForm && (
                        <div className="feedback-form">
                          <textarea
                            className="feedback-textarea"
                            value={scheduleFeedbackText}
                            onChange={(e) => setScheduleFeedbackText(e.target.value)}
                            placeholder={t.scheduleFeedbackPlaceholder}
                          />
                          <button
                            className="choose-button"
                            onClick={handleSubmitScheduleFeedbackClick}
                            disabled={isSubmittingScheduleFeedback || !scheduleFeedbackText.trim()}
                          >
                            {isSubmittingScheduleFeedback ? t.submittingFeedback : t.submitFeedback}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              <a
                className="export-button"
                href={`${BACKEND_URL}/api/shoot-schedule/${shootSchedule.id}/export?lang=${language}`}
              >
                {t.exportAsPdf}
              </a>
            </>
          )}
        </div>
      )}
    </div>
      </main>
    </div>
  )
}

export default App
