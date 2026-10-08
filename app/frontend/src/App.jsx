import { useState, useEffect, useRef, useContext, createContext, Fragment } from 'react'
import { createPortal } from 'react-dom'
import './App.css'

// Lets MicInput/MicTextarea reach the shared dictation language + t
// anywhere in the tree without threading those two props through every
// intermediate component between App and wherever a text field lives.
const DictationContext = createContext(null)
function useDictationContext() {
  return useContext(DictationContext)
}

// Ticks up once a second for as long as `active` is true, resetting to 0
// whenever it goes false. Used to show a live elapsed-time count next to a
// long-running AI call so it's visibly still working, not stuck.
function useElapsedSeconds(active) {
  const [seconds, setSeconds] = useState(0)
  const startRef = useRef(null)

  useEffect(() => {
    if (!active) {
      setSeconds(0)
      startRef.current = null
      return undefined
    }
    startRef.current = Date.now()
    setSeconds(0)
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - startRef.current) / 1000)), 1000)
    return () => clearInterval(id)
  }, [active])

  return seconds
}

// There's no real backend progress to poll here — each of these is one
// blocking AI call, not a staged run like the auto-pipeline widget has.
// So the percentage is an ESTIMATE: it climbs quickly at first then eases
// off, capped at 95% until the call actually finishes (never claims 100%
// while still waiting, and never goes backwards). `estimatedSeconds` is a
// rough guess at how long this particular call usually takes — get it
// wrong and the bar just eases off sooner or later, it doesn't break.
function estimatedProgressPercent(elapsedSeconds, estimatedSeconds) {
  const timeConstant = estimatedSeconds / 2.3
  const percent = 100 * (1 - Math.exp(-elapsedSeconds / timeConstant))
  return Math.min(95, Math.round(percent))
}

function AnalyzingProgressBar({ active, label, estimatedSeconds = 30 }) {
  const seconds = useElapsedSeconds(active)
  if (!active) return null
  const percent = estimatedProgressPercent(seconds, estimatedSeconds)
  return (
    <div className="inline-progress">
      <div className="inline-progress-track">
        <div className="inline-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <p className="inline-progress-label">
        {label} · {percent}% · {seconds}s
      </p>
    </div>
  )
}

// Env-driven so the same build works against localhost in dev and the
// deployed Render backend in production (set VITE_BACKEND_URL at build time).
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000'
const CURRENT_CONCEPT_STORAGE_KEY = 'filmmaking-app:currentConceptId'
const CURRENT_AI_MOVIE_PROJECT_STORAGE_KEY = 'filmmaking-app:currentAiMovieProjectId'

// Every fetch() in this file targets our own backend — patched once here so
// the session cookie (set by /api/auth/login) rides along on every request
// without having to add `credentials: 'include'` to dozens of call sites
// individually.
const nativeFetch = window.fetch.bind(window)
window.fetch = (url, options = {}) => nativeFetch(url, { ...options, credentials: 'include' })

const LABELS = {
  en: {
    heading: 'Filmmaking App',
    loginWelcomeHeading: 'Get into your project — happy filming. Log in to explore.',
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
    stageCrewLabel: 'Crew',
    stageScheduleLabel: 'Shoot Schedule',
    stageClapboardLabel: 'Clapboard',
    clapboardSceneLabel: 'Scene',
    clapboardPickFromSchedule: 'Pick from schedule…',
    clapboardSceneManualPlaceholder: 'Or type scene number',
    clapboardShotLabel: 'Shot',
    clapboardTakeLabel: 'Take',
    clapboardTapHintStart: 'Tap Shoot to start',
    clapboardTapHintStop: 'Tap Shoot to stop',
    clapboardLogError: "Couldn't save that clap — check your connection and try again.",
    clapboardHistoryHeading: 'Clap History',
    clapboardHistoryEmpty: 'No claps logged yet.',
    clapboardNoBannerLabel: 'No show banner uploaded yet',
    clapboardChangeBannerButton: 'Change Banner',
    clapboardUploadingBannerLabel: 'Uploading…',
    crewHeading: 'Crew',
    downloadAllCrewExcelLabel: 'Download All Crew (Excel)',
    artDepartmentHeading: 'Art Department',
    costumeDepartmentHeading: 'Costume Department',
    directionTeamHeading: 'Direction Team',
    productionTeamHeading: 'Production Team',
    otherCrewHeading: 'Other / Additional Crew',
    crewGroupHeading: 'Crew',
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
    changesChatWorkingLabel: 'Working on it',
    generateIdeaButton: 'Generate Idea',
    micButtonTitle: 'Speak instead of typing',
    micButtonListeningTitle: 'Listening… click to stop',
    micLanguageSelectTitle: 'Language you\'ll speak in',
    micLanguageEnglish: 'EN',
    micLanguageHindi: 'HI',
    micLanguageOdia: 'OR',
    changesChatAppliedMessage: '✅ Done — applied and regenerated.',
    changesChatErrorMessage: '⚠️ Something went wrong — please try again.',
    agentChatInputPlaceholder: 'Ask a question or describe a change — attach a photo too if it helps…',
    agentChatAttachPhotoLabel: 'Attach a photo (handwritten note or cast photo)',
    useCameraLabel: 'Use camera',
    attachDocumentLabel: 'Attach a document (PDF or Word)',
    cameraModalHeading: 'Take a photo',
    captureButtonLabel: 'Capture',
    captureAnotherButtonLabel: 'Capture Another',
    doneCapturingButtonLabel: 'Done',
    whatIsThisPrompt: 'What is this?',
    describeAttachmentPlaceholder: 'What is this? Describe it, then send…',
    cameraAccessError: 'Could not access the camera — check your browser permissions and try again.',
    cameraNotAvailableError: 'Camera is not available in this browser.',
    agentChatPhotoAttachedNote: 'Photo attached',
    agentChatCancelledNote: 'Cancelled — nothing was changed.',
    agentChatGreetingHi: 'Hi',
    agentChatGreetingPrompt: 'What would you like to do?',
    scheduleSuggestion1: "Change something in a scene",
    scheduleSuggestion2: 'Reassign who plays a character',
    scheduleSuggestion3: "Ask what's scheduled for a given day",
    breakdownSuggestion1: 'Reassign who plays a character',
    breakdownSuggestion2: 'Ask about the cast list',
    breakdownSuggestion3: 'Ask about locations or props',
    exportButtonLabel: 'Save Project',
    exportingProjectLabel: 'Saving…',
    connectGoogleContactsButton: 'Connect Google Contacts',
    googleContactsConnectedLabel: '✅ Google Contacts connected',
    googleContactsConnectedNotice: 'Google Contacts connected.',
    googleContactsErrorNotice: 'Could not connect Google Contacts. Please try again.',
    pickFromContactsButton: 'Pick from Google Contacts',
    downloadAuditionSidesButton: 'Download Character Script',
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
    bulkDeleteProjectsConfirm: (count) => `Delete ${count} selected project${count === 1 ? '' : 's'}? This cannot be undone.`,
    selectProjectCheckboxTitle: 'Select this project',
    deleteSelectedProjectsButton: (count) => `Delete Selected (${count})`,
    deletingSelectedProjectsButton: 'Deleting...',
    startStageLabel: 'Start from:',
    startStageIdea: 'Idea',
    startStageSynopsis: 'Synopsis',
    startStageBitSheet: 'Bit Sheet',
    startStageSceneList: 'Scene One-Liners',
    skipPastePlaceholderIdea: 'Paste your idea here…',
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
    appModeQuestion: 'Movie or AI Movie?',
    appModeMovieOption: 'Movie',
    appModeAiMovieOption: 'AI Movie',
    aiMovieProductionLabel: 'Production',
    aiMovieAnalyzeIntro: 'Paste anything — a concept, story, synopsis, bit sheet, or screenplay — and this will tell you what stage it\'s at.',
    aiMovieAnalyzePlaceholder: 'Paste anything here…',
    aiMovieAnalyzeButton: 'Analyze',
    aiMovieAnalyzingLabel: 'Analyzing…',
    aiMovieStageResultConcept: 'This is at the Concept stage.',
    aiMovieStageResultStory: 'This story is in the Story stage.',
    aiMovieStageResultSynopsis: 'This story is in the Synopsis stage.',
    aiMovieStageResultBitsheet: 'This story is in the Bit Sheet stage.',
    aiMovieStageResultScreenplay: 'This is at the Screenplay stage.',
    aiMovieStageResultOther: "Couldn't confidently place this in one of the usual stages.",
    aiMovieProceedButton: 'Proceed',
    aiMovieBackfillingLabel: 'Filling in the earlier stages…',
    aiMovieBackfillNoteEarliest: "This is already the earliest stage — nothing earlier to fill in.",
    aiMovieBackfillNoteOther: "Couldn't confidently place a stage, so nothing was filled in automatically.",
    aiMovieStoryLayerHeading: 'Story',
    aiMovieSynopsisLayerHeading: 'Synopsis',
    aiMoviePlotLayerHeading: 'Plot',
    aiMovieCharacterArcLayerHeading: 'Character Arc',
    aiMovieReferenceHeading: 'Reference Material',
    aiMovieReferenceIntro: "Give the agents extra source material to work from — a real book your story draws from, or your own character/property/art details — and they'll treat it as authoritative rather than inventing their own. Whatever you add is read and sorted automatically, nothing to label by hand.",
    aiMovieReferencePastePlaceholder: 'Paste text here…',
    aiMovieReferenceAddButton: 'Add',
    aiMovieReferenceAddingLabel: 'Adding…',
    aiMovieReferenceUploadButton: 'Upload files (PDF, Word, text, markdown, or a .zip of several)',
    aiMovieReferenceUploadingLabel: 'Uploading…',
    aiMovieReferenceEmptyNote: 'Nothing attached yet.',
    aiMovieReferenceRemoveTitle: 'Remove',
    aiMovieReferenceUntitledLabel: 'Untitled',
    aiMovieGenerateFromReferenceButton: 'Generate Story from Reference Material',
    aiMovieGeneratingFromReferenceLabel: 'Generating…',
    aiMovieStageLabelStory: 'Story',
    aiMovieStageLabelSynopsis: 'Synopsis',
    aiMovieStageLabelCharacterArc: 'Characters',
    aiMovieStageLabelThreeAct: 'Three-Act Structure',
    aiMovieStageLabelPlot: 'Beat Sheet',
    aiMovieStageLabelScreenplay: 'Screenplay',
    aiMovieGenerateStageButton: (label) => `Generate ${label}`,
    aiMovieGeneratingStageLabel: 'Generating…',
    aiMovieAllStagesLockedNote: 'Everything is locked in — Story, Synopsis, Characters, Three-Act Structure, Beat Sheet, and Screenplay are all approved.',
    aiMovieThreeActTurningPointLabel: 'Turning point',
    aiMovieDeleteProjectButton: 'Delete',
    aiMovieDeleteProjectConfirm: 'Delete this AI Movie project for good? This cannot be undone.',
    aiMovieSeedAkhadaButton: 'New Story: Akhada (from uploaded files)',
    aiMovieSeedingAkhadaLabel: 'Creating…',
    aiMovieFillAkhadaStagesButton: 'Fill Synopsis → Beat Sheet from your files (skip re-review)',
    aiMovieFillingAkhadaStagesLabel: 'Filling in…',
    aiMovieFillBeatDurationsButton: 'Sync exact beat durations from your files',
    aiMovieFillingBeatDurationsLabel: 'Syncing…',
    aiMovieFillBeatDurationsResultNote: (updated, total) => `Updated ${updated} of ${total} beats with their exact duration.`,
    aiMovieScreenplayGenerateButton: 'Generate Screenplay',
    aiMovieScreenplayStartingLabel: 'Starting…',
    aiMovieScreenplayBeatWritingLabel: "Writing this beat's scenes…",
    aiMovieScreenplayBeatErrorLabel: 'Something went wrong generating this beat.',
    aiMovieScreenplayRetryButton: 'Retry',
    aiMovieBeatShortNote: 'This beat is shorter than its Beat Sheet time — use "Extend to target" below (it keeps everything already written).',
    aiMovieBeatLongNote: 'This beat runs longer than its Beat Sheet time — use "Request Changes" on a scene to tighten it.',
    aiMovieDoctorButton: 'Script Doctor',
    aiMovieDoctorRerunButton: 'Run Script Doctor again',
    aiMovieDoctorRunningLabel: 'Reviewing this beat…',
    aiMovieDoctorNoNotes: 'No real problems found in this beat.',
    aiMovieDoctorMajor: 'MAJOR',
    aiMovieDoctorMinor: 'minor',
    aiMovieDoctorSceneLabel: (n) => `Scene ${n}`,
    aiMovieDoctorWholeBeatLabel: 'Whole beat',
    aiMovieDoctorCategoryLabels: { pacing: 'Pacing', story_logic: 'Story logic', continuity: 'Continuity', character: 'Character', setup_payoff: 'Setup / payoff', world_rules: 'World rules', emotion: 'Emotion', interval: 'Interval' },
    aiMovieDoctorFixLabel: 'Fix',
    aiMovieDoctorApplyButton: 'Apply this fix',
    aiMovieDoctorApplyingLabel: 'Applying…',
    aiMovieDoctorAppliedLabel: '✓ Applied',
    aiMovieDoctorSceneChangedLabel: 'This scene has changed since the review — run Script Doctor again.',
    aiMovieDoctorUseInRequestChangesButton: 'Use in Request Changes',
    aiMovieDoctorWholeBeatWarning: 'This rewrites the whole beat — its scenes and dialogue will be replaced. Edit the fix if you like, then Submit.',
    aiMovieSongSheetLabel: 'Song',
    aiMovieWriteSongSheetButton: 'Write Song Sheet',
    aiMovieRewriteSongSheetButton: 'Rewrite Song Sheet',
    aiMovieWritingSongSheetLabel: 'Writing song sheet…',
    aiMovieSongSituationLabel: 'Situation',
    aiMovieSongPurposeLabel: 'What changes',
    aiMovieSongMoodLabel: 'Mood',
    aiMovieSongMusicLabel: 'Music',
    aiMovieSongSingersLabel: 'Singers',
    aiMovieSongLyricistBriefLabel: 'Brief for the lyricist',
    aiMovieSongPicturizationLabel: 'How it is filmed',
    aiMovieSetIntervalButton: (minutes) => (minutes ? `Interval goes after this beat (at ${minutes} min)` : 'Interval goes after this beat'),
    aiMovieRemoveIntervalButton: 'Remove interval',
    aiMovieIntervalMarker: '— INTERVAL after this beat —',
    aiMovieScenePurposeLabels: { plot_advancing: 'Plot', character_revealing: 'Character', both: 'Plot + Character' },
    aiMovieScreenplayPdfButton: (lang) => `Download Screenplay PDF (${lang === 'hi' ? 'Hindi' : 'English'})`,
    aiMovieExtendToTargetButton: (target) => `Extend to ${aiMovieDurationText(target, 'sec', 'min')}`,
    aiMovieExtendingToTargetLabel: 'Extending this beat…',
    aiMovieExtendToTargetNote: 'Keeps every scene and line already written — only adds more screenplay (dialogue first, then new scenes) until the beat reaches its Beat Sheet time.',
    aiMovieScreenplayBeatOfLabel: (index, total) => `Beat ${index} of ${total}`,
    aiMovieScreenplayAllApprovedNote: 'Full screenplay draft complete — every beat approved.',
    aiMovieReviseSceneButton: 'Request Changes',
    aiMovieReviseSceneCancelButton: 'Cancel',
    aiMovieReviseScenePlaceholder: 'Optional — say what to change, e.g. "make it longer", "change the mood", "fix the ending" (leave blank to let the AI improve it)',
    aiMovieReviseSceneSubmitButton: 'Submit',
    aiMovieRevisingSceneLabel: 'Revising…',
    aiMovieSceneDurationLabel: (minutes) => `Duration: ~${aiMovieDurationText(minutes, 'sec', 'min')}`,
    aiMovieTotalRuntimeLabel: (total, target) => `Estimated total: ${aiMovieDurationText(total, 'sec', 'min')} (target: ${aiMovieDurationText(target, 'sec', 'min')})`,
    aiMovieWriteDialogueButton: 'Write Dialogue',
    aiMovieRewriteDialogueButton: 'Rewrite Dialogue',
    aiMovieDialogueCancelButton: 'Cancel',
    aiMovieDialoguePlaceholder: 'Optional — any direction for the dialogue, e.g. "make this a tense argument" (leave blank to let the AI decide)',
    aiMovieBeatNarrationButton: 'Narration for this whole beat',
    scriptThemeLabel: 'Page colour',
    movieScriptNotWrittenLabel: 'not written yet',
    movieScriptNotWrittenShort: 'not written',
    movieScriptOutlineLabel: 'Outline',
    movieScriptApproveFirstNote: 'Approve the scene list (below) to start writing scenes.',
    movieScriptEditSubmitNote: 'Submit — the AI fixes spelling, grammar and language (action lines in English, dialogue in this scene\'s language — e.g. English or romanized text in an Odia scene), keeps your words and events, and saves it as a new version.',
    movieScriptCheckNote: 'When the script is written: checks every written scene — spelling, grammar and language — and keeps your content. Each corrected scene is saved as a new version.',
    movieScriptCheckConfirm: (scenes, calls) => `Check the full script? This checks all ${scenes} written scenes — about ${calls} AI call${calls === 1 ? '' : 's'}, and it can take several minutes. It runs in the background.`,
    movieScriptCheckRunningLabel: (done, total) => `Checking scenes… ${done} of ${total || '…'}`,
    movieScriptCheckShowReport: (fixes, scenes) => `Show report (${fixes} fixes in ${scenes} scenes)`,
    movieScriptCheckSceneLabel: (number, heading) => `Scene ${number}: ${heading}`,
    movieScriptCheckChangedNote: (count) => `${count} line(s) corrected.`,
    movieBreakdownStaleNote: 'The script has changed since the Script Breakdown was made — re-run the breakdown in Production to bring it up to date.',
    aiMovieScriptCheckButton: '✔ Check full script',
    aiMovieScriptCheckRunningLabel: (done, total) => `Checking beat ${Math.min(done + 1, total)} of ${total}…`,
    aiMovieScriptCheckNote: 'When the script is written: checks every written beat — spelling, grammar and language in both Hindi and English — and keeps your content.',
    aiMovieScriptCheckRunningNote: 'Running in the background — you can keep working. Corrected scenes appear as each beat finishes.',
    aiMovieScriptCheckDoneNote: (finishedAt, failed) => `Last full check: ${finishedAt ? new Date(finishedAt).toLocaleString() : ''}${failed ? ` — ${failed} beat(s) could not be checked, run it again to retry` : ''}.`,
    aiMovieScriptCheckConfirm: (beats) => `Check the full script? This checks all ${beats} written beats — about ${beats} AI calls, and it takes several minutes. It runs in the background.`,
    aiMovieScriptCheckShowReport: (fixes, beats) => `Show report (${fixes} fixes in ${beats} beats)`,
    aiMovieScriptCheckHideReport: 'Hide report',
    aiMovieScriptCheckBeatLabel: (number, title) => `Beat ${number}: ${title ?? ''}`,
    aiMovieScriptCheckSceneLabel: (number) => `Scene ${number}`,
    aiMovieScriptCheckBeatFailed: 'This beat could not be checked — run the check again to retry.',
    scriptEditStartButton: '✎ Edit scene',
    scriptEditEditingNote: 'Editing on the page — type straight into the script, then press Submit under the scene.',
    scriptEditDoubleClickHint: 'Double-click to edit this scene',
    sceneManageTitle: 'Add or remove scenes',
    sceneAddBeforeButton: '＋ Add scene before',
    sceneAddAfterButton: '＋ Add scene after',
    sceneDeleteButton: '🗑 Delete scene',
    sceneDeleteConfirm: (number) => `Delete scene ${number}? Its script is removed for good and the scenes after it move up by one.`,
    sceneNewTitle: (number) => `New scene ${number}`,
    sceneNewIntExtLabel: 'Inside or outside',
    sceneNewInt: 'INT (inside)',
    sceneNewExt: 'EXT (outside)',
    sceneNewLocationLabel: 'Place',
    sceneNewLocationPlaceholder: 'e.g. Temple courtyard',
    sceneNewTimeLabel: 'Time',
    sceneNewTimeOptions: { DAY: 'Day', NIGHT: 'Night', MORNING: 'Morning', EVENING: 'Evening' },
    sceneNewWhatLabel: 'What happens',
    sceneNewWhatPlaceholder: 'One or two lines: who is there, what happens, how it ends',
    sceneNewMinutesLabel: 'Length (minutes)',
    sceneNewWriteAiButton: 'Add and write with AI',
    sceneNewBlankButton: 'Add blank (I will write it)',
    sceneNewCancelButton: 'Cancel',
    sceneNewSavingLabel: 'Adding…',
    sceneNewNoteAfterChange: 'The scene numbers after it have moved. If you already made a script breakdown or shoot schedule, check them again.',
    scriptEditHeadingLabel: 'Scene heading',
    scriptEditCharacterPlaceholder: 'CHARACTER',
    scriptEditParentheticalPlaceholder: '(acting note — optional)',
    scriptEditLinePlaceholder: 'Dialogue…',
    scriptEditActionPlaceholder: 'Action…',
    scriptEditActionShort: 'Action',
    scriptEditDialogueShort: 'Dialogue',
    scriptEditAddActionButton: 'Add an action line after this',
    scriptEditAddDialogueButton: 'Add a dialogue line after this',
    scriptEditRemoveButton: 'Remove this line',
    scriptEditSubmitNote: 'Submit — the AI fixes spelling, grammar and language (e.g. English typed in the Hindi version), keeps your words and events, and updates the other language to match.',
    scriptEditSubmitButton: 'Submit',
    scriptEditSubmittingLabel: 'Checking your scene…',
    scriptEditFixesTitle: 'What the AI fixed',
    scriptEditNoFixesNote: 'Nothing needed fixing.',
    aiMovieStageNotOpenYetNote: 'This stage opens once the one before it is approved.',
    scriptScenesTitle: 'Scenes',
    scriptSelectedSceneTitle: (number) => `Scene ${number}`,
    scriptAiWritingLabel: 'AI is writing…',
    aiMovieShortDuration: (minutes) => aiMovieDurationText(minutes, 'sec', 'min'),
    scriptThemeLight: '☀ Light',
    scriptThemeDark: '☾ Dark',
    aiMovieBeatNarrationNote: 'Writes one continuous narrator voice-over that flows across every scene of this beat, in order. Dialogue already written is kept.',
    aiMovieBeatNarrationPlaceholder: 'Describe the narration for this beat, e.g. "Narrator explains how war and pollution emptied Earth, people left for colonies, and only the gods and temples remained."',
    aiMovieBeatNarrationSubmitButton: 'Write Narration',
    aiMovieBeatNarrationProgress: (scene, total) => `Writing narration — scene ${scene} of ${total}…`,
    aiMovieBeatNarrationSceneError: (scene, message) => `Scene ${scene}: ${message}`,
    aiMovieDialogueSubmitButton: 'Write Dialogue',
    aiMovieWritingDialogueLabel: 'Writing…',
    aiMovieNoDialogueNeededNote: 'No dialogue needed for this scene.',
    formatQuestion: 'Is this a film, a web series, or a vertical drama?',
    filmOption: 'Film',
    seriesOption: 'Web Series',
    verticalDramaOption: 'Vertical Drama',
    episodeCountLabel: 'Number of episodes',
    episodeMinutesLabel: 'Minutes per episode',
    runtimeMinutesLabel: 'Total runtime (minutes)',
    buildPitchDeck: 'Build Pitch Deck',
    buildingPitchDeck: 'Building pitch deck...',
    cancel: 'Cancel',
    storyHeading: 'Story',
    premise: 'Synopsis',
    toneGenre: 'Tone / Genre',
    targetAudience: 'Target Audience',
    highlightsHeading: 'Unique Elements',
    sponsorshipAngleHeading: 'Sponsorship Angle',
    majorCharactersHeading: 'Major Characters',
    emotionalCoreLabel: 'Emotional Core',
    conflictLabel: 'Conflict',
    exportAsPdf: 'Download Presentation',
    formatFilm: 'FEATURE FILM',
    formatSeries: (count, minutes) => `WEB SERIES · ${count} EPISODES × ${minutes} MIN EACH`,
    formatVertical: (count, minutes) => `VERTICAL DRAMA · ${count} EPISODES × ${minutes} MIN EACH`,
    episodeBreakdown: 'Episode Breakdown',
    episodeLabel: 'Episode',
    hookLabel: 'Hook',
    genericError: 'Something went wrong. Please wait a moment and try again.',
    breakdownTimedOutError: "This script is taking unusually long to analyze. It's likely still running in the background — please check back in a few minutes, or refresh the page.",
    screenplayUploadedToast: 'Screenplay uploaded successfully. Click "Analyze Script" below to generate the breakdown (characters, props, locations, and more).',
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
    classifyCastCategoriesButton: 'Classify Cast Categories',
    classifyingCastCategoriesLabel: 'Classifying...',
    classifyCastCategoriesHint: 'Scans the full script and sorts every character into groups: Lead, Sidekick, Extra/Junior (all speaking roles, by narrative importance), or non-speaking (present but silent, or only ever heard).',
    castCategorySpeakingLabel: 'Speaking / Lead Artists',
    castCategoryActionOnlyLabel: 'Action Only (No Dialogue)',
    castCategoryOffScreenLabel: 'Off-Screen / Voice Only (Not Called on Set)',
    castCategoryUnclassifiedLabel: 'Not Yet Classified',
    castTierLeadLabel: 'Lead Characters',
    castTierSidekickLabel: 'Sidekicks',
    castTierExtraLabel: 'Extras / Junior Artists',
    castTierNonSpeakingLabel: 'Non-Speaking Characters',
    classifyEpisodeNumbersButton: 'Tag Episode Numbers',
    classifyingEpisodeNumbersLabel: 'Tagging episodes...',
    classifyEpisodeNumbersHint: 'Scans the full script and notes which episode(s) every character, location, prop, costume, and art-department item appears in.',
    episodeNumbersPrefix: 'Ep',
    juniorArtistCoordinatorHeading: 'Junior Artist Coordinator',
    juniorArtistCoordinatorHint: 'Add ONE coordinator here to mark every Extra/Junior character below as cast — no need to cast each one individually.',
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
    structureModelLabel: 'Structure:',
    structureModelNames: {
      three_act: 'Three-Act',
      five_act: 'Five-Act',
      heros_journey: "Hero's Journey",
      kishotenketsu: 'Kishōtenketsu (four-part, with a twist)',
      non_linear: 'Non-linear',
      ensemble: 'Ensemble (several protagonists)',
      real_time: 'Real-time',
    },
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
    intExtLabel: 'INT/EXT',
    locationLabel: 'Location',
    descriptionLabel: 'Description',
    movingScenesToDayLabel: 'Moving these scenes to Day',
    affectedScenesHeading: 'Scenes this touches:',
    dayLabel: 'DAY',
    nightLabel: 'NIGHT',
    approveSceneListButton: 'Approve Scene List',
    sceneListApprovedBadge: '✅ Scene List Approved',
    sceneListFeedbackPlaceholder: 'What would you like changed? e.g. "Scene 4 needs more tension" or "Merge scenes 2 and 3"',
    approxMinutesUnit: (minutes) => `~${aiMovieDurationText(minutes, 'sec', 'min')}`,
    totalRuntimeLabel: (total, target) => `Estimated total: ${aiMovieDurationText(total, 'sec', 'min')} (target: ${aiMovieDurationText(target, 'sec', 'min')})`,
    runtimeMismatchNote: 'This is off from the target runtime — use "Request Changes" below to ask for more or fewer scenes.',
    writeSceneButton: 'Write This Scene',
    generatingScreenplayScene: 'Writing scene...',
    screenplayCharactersLabel: 'Characters',
    dialogueLanguageEnglish: 'Dialogue: English',
    dialogueLanguageOdia: 'Dialogue: Odia',
    dialogueLanguageHindi: 'Dialogue: Hindi',
    floatingAgentTitle: 'Auto Screenplay Agent',
    floatingAgentConceptPlaceholder: 'Describe your concept — e.g. "A daughter-in-law and her mother-in-law are forced to run the household together after the son goes abroad for work."',
    floatingAgentStartButton: 'Start',
    floatingAgentStarting: 'Starting...',
    floatingAgentStageLabel: 'Stage',
    floatingAgentStageNames: {
      starting: 'Getting started',
      storylines: 'Coming up with storylines',
      'pitch-deck': 'Writing the pitch deck',
      'character-sheet': 'Building the characters',
      'three-act': 'Structuring the story',
      'bit-sheet': 'Breaking it into beats',
      'scene-list': 'Writing the scene list',
      screenplay: 'Writing the screenplay',
      'sequence-review': 'Script editor reviewing the screenplay, sequence by sequence',
      'quality-pass': 'Final quality pass — checking for repetition',
      'language-check': 'Final language check — grammar and natural dialogue',
      'story-brain': 'Story Brain designing the story',
      'story-bible': 'Story Bible — your approval',
      'story-bible-approved': 'Story Bible approved',
      done: 'Done',
    },
    floatingAgentStatusAwaiting: 'Waiting for you',
    floatingAgentStatusApproved: 'Approved',
    bibleReadyLabel: 'The Story Bible is ready. Read it, then approve it or give a note.',
    bibleCriticsPassed: 'The critics passed it',
    bibleCriticsNeedInput: "The critics didn't all reach 8 — see the open problems",
    bibleCriticDoctor: 'Story doctor',
    bibleCriticAudience: 'Audience',
    bibleCriticCulture: 'Culture',
    bibleQuestionLabel: 'The question that keeps people watching',
    bibleOpeningLabel: 'Opening and its ending hook',
    bibleClimaxLabel: 'Climax',
    bibleFinalImageLabel: 'Final image',
    bibleEpisodeHooksLabel: 'How each episode ends',
    bibleSequenceHooksLabel: 'How each sequence ends',
    bibleOpenProblemsLabel: (count) => `Problems the critics still see (${count})`,
    bibleOpenFullButton: 'Open the full Story Bible',
    bibleApproveButton: 'Approve',
    bibleNotePlaceholder: 'Your note — what should change? e.g. "Keep the grandmother alive" or "The climax needs a bigger twist"',
    bibleSendNoteButton: 'Revise with my note',
    bibleSending: 'Sending...',
    bibleApprovedLabel: 'Approved — the script is being written from this Story Bible.',
    floatingAgentSecondsSuffix: 's',
    floatingAgentFilmMinutesLabel: 'Film length (minutes)',
    floatingAgentStatusWorking: 'Working',
    floatingAgentStatusStopped: 'Stopped',
    floatingAgentTimelineTitle: 'Stages',
    floatingAgentNotesTitle: 'What the agents said',
    floatingAgentOpenProjectButton: 'Open in Movie screen',
    floatingAgentDoneLabel: 'Your screenplay is ready.',
    floatingAgentDownloadButton: 'Download Screenplay',
    floatingAgentTranslateDownloadButton: 'Translate & Download',
    floatingAgentFormatPdf: 'PDF',
    floatingAgentFormatWord: 'Word (.docx)',
    floatingAgentNewRunButton: 'Start a New Run',
    floatingAgentResumeButton: 'Resume from Where It Failed',
    floatingAgentResuming: 'Resuming...',
    screenplayFeedbackPlaceholder: 'What would you like changed about this scene? e.g. "Make the dialogue sharper" or "Add a beat of hesitation before he answers"',
    screenplayCompleteBanner: '🎬 Full screenplay draft complete! This locked structure and final screenplay are ready to hand off to the next stage.',
    screenplayProgressLabel: (drafted, total) => `Screenplay progress: ${drafted} / ${total} scenes written`,
    productionHeading: 'Production Management',
    scriptBreakdownHeading: 'Script Breakdown',
    autoBackfillInProgressNote: 'Updating cast tiers and episode numbers in the background — this can take a few minutes. This page will refresh automatically once it\'s done, nothing to click.',
    autoBackfillRetryingNote: 'The last background update attempt failed — retrying automatically now. This page will refresh once it succeeds.',
    generateBreakdownButton: 'Analyze Script',
    cancelBreakdownButton: 'Cancel & retry',
    generatingBreakdownLabel: 'Analyzing script...',
    generateAdSheetButton: 'Generate AD Scene Breakdown Sheet',
    generatingAdSheetLabel: 'Generating AD sheet...',
    downloadAdSheetLabel: 'Download AD Scene Breakdown Sheet',
    artistListHeading: 'Artist List (Cast)',
    locationListHeading: 'Location List',
    propsHeading: 'Property List (Props)',
    costumesHeading: 'Costume Changes',
    artHeading: 'Art Department Notes',
    propsAndArtHeading: 'Properties & Art Department Notes',
    costumeRecommendationsHeading: 'Recommended Costume Quantities',
    generateCostumeRecommendationsButton: 'Recommend Costume Quantities',
    generatingCostumeRecommendationsLabel: 'Analyzing scenes…',
    costumeApprovedBadge: '✅ Approved — locked',
    regenerateCostumeRecommendationButton: 'Regenerate',
    editCostumeSetsButton: 'Add / Remove Costume',
    removeCostumeSetButton: 'Remove',
    addCostumeSetButton: 'Add Another',
    approveCostumeButton: 'Approve',
    costumeSetCategoryPlaceholder: 'Costume category (e.g. Office Wear)',
    costumeSetQuantityPlaceholder: 'Quantity',
    costumeSetReasonPlaceholder: 'Reason (optional)',
    costumeRecommendationsNeedsAdSheetHint: 'Generate the AD Scene Breakdown Sheet first — this needs it to know which scenes each character is in.',
    downloadLabel: 'Download',
    downloadFormatPdf: 'PDF',
    downloadFormatExcel: 'Excel',
    downloadFormatPpt: 'PowerPoint',
    pitchDeckDownloadHint: 'Create the characters first to unlock the presentation download — their details get included in it.',
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
    dayMasterBreakdownLabel: 'Day Breakdown — Master',
    dayArtistBreakdownLabel: 'Artist Breakdown',
    dayLocationBreakdownLabel: 'Location Breakdown',
    dayCostumeBreakdownLabel: 'Costume Breakdown',
    dayPropertiesBreakdownLabel: 'Properties Breakdown',
    dayCallSheetLabel: 'Call Sheet',
    costumeLabel: 'Costume',
    propertiesLabel: 'Properties',
    adRemarkLabel: 'AD Remark',
    editSceneButton: 'Edit',
    saveButton: 'Save',
    savingLabel: 'Saving…',
    uploadHandwrittenNoteButton: 'Upload Handwritten Note (Photo)',
    interpretingHandwrittenNoteLabel: 'Reading photo…',
    handwrittenNoteHint: 'Take or upload a photo of a handwritten note (properties, costume notes, remarks) — it will be read and shown to you for confirmation before anything is changed.',
    couldNotPlaceLabel: "Couldn't place — add manually",
    confirmApplyButton: 'Confirm & Apply',
    applyingLabel: 'Applying…',
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
    extraScenesReportIntro: 'Did you shoot any extra scenes today, ahead of schedule?',
    extraScenesReportPlaceholder: 'e.g. "Also shot Episode 4 scene 12 and 13 while we were at that location."',
    extraScenesFoundHeading: 'Extra scenes found — review before confirming:',
    prepareNextDaysButton: 'Prepare Next Days’ Schedule',
    preparingNextDaysLabel: 'Preparing…',
    prepareNextDaysFeedback: 'Reflow the remaining unscheduled scenes across the remaining shoot days now that the most recently recorded day is complete — keep already-completed days untouched.',
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
      skeptic: 'Skeptic',
      community: 'Community',
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
    loginWelcomeHeading: 'ଆପଣଙ୍କର ପ୍ରୋଜେକ୍ଟରେ ପ୍ରବେଶ କରନ୍ତୁ — ଶୁଭ ଚିତ୍ରଗ୍ରହଣ। ଅନ୍ୱେଷଣ କରିବାକୁ ଲଗ୍ ଇନ୍ କରନ୍ତୁ।',
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
    stageCrewLabel: 'କ୍ରୁ',
    stageScheduleLabel: 'ସୁଟିଂ ସିଡ୍ୟୁଲ୍',
    stageClapboardLabel: 'କ୍ଲାପ୍‌ବୋର୍ଡ',
    clapboardSceneLabel: 'ଦୃଶ୍ୟ',
    clapboardPickFromSchedule: 'ସୂଚୀରୁ ବାଛନ୍ତୁ…',
    clapboardSceneManualPlaceholder: 'କିମ୍ବା ଦୃଶ୍ୟ ସଂଖ୍ୟା ଟାଇପ୍ କରନ୍ତୁ',
    clapboardShotLabel: 'ସଟ୍',
    clapboardTakeLabel: 'ଟେକ୍',
    clapboardTapHintStart: 'ଆରମ୍ଭ କରିବାକୁ ସୁଟ୍ ଟାପ୍ କରନ୍ତୁ',
    clapboardTapHintStop: 'ବନ୍ଦ କରିବାକୁ ସୁଟ୍ ଟାପ୍ କରନ୍ତୁ',
    clapboardLogError: 'ସେହି କ୍ଲାପ୍ ସେଭ୍ ହୋଇପାରିଲା ନାହିଁ — ଆପଣଙ୍କ ସଂଯୋଗ ଯାଞ୍ଚ କରି ପୁଣି ଚେଷ୍ଟା କରନ୍ତୁ।',
    clapboardHistoryHeading: 'କ୍ଲାପ୍ ଇତିହାସ',
    clapboardHistoryEmpty: 'ଏପର୍ଯ୍ୟନ୍ତ କୌଣସି କ୍ଲାପ୍ ଲଗ୍ ହୋଇନାହିଁ।',
    clapboardNoBannerLabel: 'ଏପର୍ଯ୍ୟନ୍ତ କୌଣସି ସୋ ବ୍ୟାନର୍ ଅପଲୋଡ୍ ହୋଇନାହିଁ',
    clapboardChangeBannerButton: 'ବ୍ୟାନର୍ ପରିବର୍ତ୍ତନ କରନ୍ତୁ',
    clapboardUploadingBannerLabel: 'ଅପଲୋଡ୍ ହେଉଛି…',
    crewHeading: 'କ୍ରୁ',
    downloadAllCrewExcelLabel: 'ସମସ୍ତ କ୍ରୁ ଡାଉନଲୋଡ୍ କରନ୍ତୁ (Excel)',
    artDepartmentHeading: 'ଆର୍ଟ ବିଭାଗ',
    costumeDepartmentHeading: 'ପୋଷାକ ବିଭାଗ',
    directionTeamHeading: 'ନିର୍ଦ୍ଦେଶନା ଦଳ',
    productionTeamHeading: 'ପ୍ରଡକ୍ସନ୍ ଦଳ',
    otherCrewHeading: 'ଅନ୍ୟାନ୍ୟ କ୍ରୁ',
    crewGroupHeading: 'କ୍ରୁ',
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
    changesChatWorkingLabel: 'କାମ ଚାଲୁଛି',
    generateIdeaButton: 'ଆଇଡିଆ ତିଆରି କରନ୍ତୁ',
    micButtonTitle: 'ଟାଇପ୍ କରିବା ବଦଳରେ କୁହନ୍ତୁ',
    micButtonListeningTitle: 'ଶୁଣୁଛି… ବନ୍ଦ କରିବାକୁ କ୍ଲିକ୍ କରନ୍ତୁ',
    micLanguageSelectTitle: 'ଆପଣ କେଉଁ ଭାଷାରେ କହିବେ',
    micLanguageEnglish: 'EN',
    micLanguageHindi: 'HI',
    micLanguageOdia: 'OR',
    changesChatAppliedMessage: '✅ ହୋଇଗଲା — ପ୍ରୟୋଗ ଏବଂ ପୁନଃତିଆରି ହୋଇଗଲା।',
    changesChatErrorMessage: '⚠️ କିଛି ଭୁଲ ହେଲା — ପୁଣି ଚେଷ୍ଟା କରନ୍ତୁ।',
    agentChatInputPlaceholder: 'ଏକ ପ୍ରଶ୍ନ ପଚାରନ୍ତୁ କିମ୍ବା ପରିବର୍ତ୍ତନ ବର୍ଣ୍ଣନା କରନ୍ତୁ — ସାହାଯ୍ୟ ହେଲେ ଏକ ଫଟୋ ମଧ୍ୟ ଲଗାନ୍ତୁ…',
    agentChatAttachPhotoLabel: 'ଏକ ଫଟୋ ଲଗାନ୍ତୁ (ହସ୍ତଲିଖିତ ନୋଟ୍ କିମ୍ବା କାଷ୍ଟ ଫଟୋ)',
    useCameraLabel: 'କ୍ୟାମେରା ବ୍ୟବହାର କରନ୍ତୁ',
    attachDocumentLabel: 'ଏକ ଡକ୍ୟୁମେଣ୍ଟ ଲଗାନ୍ତୁ (PDF କିମ୍ବା Word)',
    cameraModalHeading: 'ଏକ ଫଟୋ ନିଅନ୍ତୁ',
    captureButtonLabel: 'କ୍ୟାପଚର୍ କରନ୍ତୁ',
    captureAnotherButtonLabel: 'ଆଉ ଏକ କ୍ୟାପଚର୍ କରନ୍ତୁ',
    doneCapturingButtonLabel: 'ହୋଇଗଲା',
    whatIsThisPrompt: 'ଏହା କଣ?',
    describeAttachmentPlaceholder: 'ଏହା କଣ? ବର୍ଣ୍ଣନା କରନ୍ତୁ, ତାପରେ ପଠାନ୍ତୁ…',
    cameraAccessError: 'କ୍ୟାମେରା ପ୍ରବେଶ କରିହେଲା ନାହିଁ — ଆପଣଙ୍କର ବ୍ରାଉଜର୍ ଅନୁମତି ଯାଞ୍ଚ କରନ୍ତୁ ଏବଂ ପୁଣି ଚେଷ୍ଟା କରନ୍ତୁ।',
    cameraNotAvailableError: 'ଏହି ବ୍ରାଉଜରରେ କ୍ୟାମେରା ଉପଲବ୍ଧ ନାହିଁ।',
    agentChatPhotoAttachedNote: 'ଫଟୋ ଲଗାଗଲା',
    agentChatCancelledNote: 'ବାତିଲ୍ ହୋଇଗଲା — କିଛି ପରିବର୍ତ୍ତନ ହେଲା ନାହିଁ।',
    agentChatGreetingHi: 'ନମସ୍କାର',
    agentChatGreetingPrompt: 'ଆପଣ କଣ କରିବାକୁ ଚାହାଁନ୍ତି?',
    scheduleSuggestion1: 'ଏକ ଦୃଶ୍ୟରେ କିଛି ପରିବର୍ତ୍ତନ କରନ୍ତୁ',
    scheduleSuggestion2: 'ଏକ ଚରିତ୍ର କିଏ ଅଭିନୟ କରୁଛନ୍ତି ତାହା ବଦଳାନ୍ତୁ',
    scheduleSuggestion3: 'ଏକ ନିର୍ଦ୍ଦିଷ୍ଟ ଦିନ ପାଇଁ କଣ ସିଡ୍ୟୁଲ୍ ହୋଇଛି ପଚାରନ୍ତୁ',
    breakdownSuggestion1: 'ଏକ ଚରିତ୍ର କିଏ ଅଭିନୟ କରୁଛନ୍ତି ତାହା ବଦଳାନ୍ତୁ',
    breakdownSuggestion2: 'କାଷ୍ଟ ତାଲିକା ବିଷୟରେ ପଚାରନ୍ତୁ',
    breakdownSuggestion3: 'ସ୍ଥାନ କିମ୍ବା ପ୍ରପର୍ଟି ବିଷୟରେ ପଚାରନ୍ତୁ',
    exportButtonLabel: 'ପ୍ରୋଜେକ୍ଟ ସେଭ୍ କରନ୍ତୁ',
    exportingProjectLabel: 'ସେଭ୍ ହେଉଛି…',
    connectGoogleContactsButton: 'Google ଯୋଗାଯୋଗ ସଂଯୋଗ କରନ୍ତୁ',
    googleContactsConnectedLabel: '✅ Google Contacts ସଂଯୁକ୍ତ',
    googleContactsConnectedNotice: 'Google Contacts ସଂଯୁକ୍ତ ହୋଇଗଲା।',
    googleContactsErrorNotice: 'Google Contacts ସଂଯୋଗ ହୋଇପାରିଲା ନାହିଁ। ପୁଣି ଚେଷ୍ଟା କରନ୍ତୁ।',
    pickFromContactsButton: 'Google Contacts ରୁ ବାଛନ୍ତୁ',
    downloadAuditionSidesButton: 'କାରାକ୍ଟର ସ୍କ୍ରିପ୍ଟ ଡାଉନଲୋଡ୍ କରନ୍ତୁ',
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
    bulkDeleteProjectsConfirm: (count) => `ବଛାଯାଇଥିବା ${count}ଟି ପ୍ରୋଜେକ୍ଟ ଡିଲିଟ୍ କରିବେ? ଏହା ପୁନଃ ପାଇ ହେବ ନାହିଁ।`,
    selectProjectCheckboxTitle: 'ଏହି ପ୍ରୋଜେକ୍ଟକୁ ବାଛନ୍ତୁ',
    deleteSelectedProjectsButton: (count) => `ବଛାଯାଇଥିବା ଡିଲିଟ୍ କରନ୍ତୁ (${count})`,
    deletingSelectedProjectsButton: 'ଡିଲିଟ୍ ହେଉଛି...',
    startStageLabel: 'ଆରମ୍ଭ କରନ୍ତୁ:',
    startStageIdea: 'ଧାରଣା',
    startStageSynopsis: 'ସିନୋପ୍ସିସ୍',
    startStageBitSheet: 'ବିଟ୍ ସିଟ୍',
    startStageSceneList: 'ସିନ୍ ଲିଷ୍ଟ',
    skipPastePlaceholderIdea: 'ଆପଣଙ୍କ ଆଇଡିଆ ଏଠାରେ ପେଷ୍ଟ କରନ୍ତୁ…',
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
    appModeQuestion: 'ମୁଭି ନା AI ମୁଭି?',
    appModeMovieOption: 'ମୁଭି',
    appModeAiMovieOption: 'AI ମୁଭି',
    aiMovieProductionLabel: 'ପ୍ରଡକ୍ସନ୍',
    aiMovieAnalyzeIntro: 'ଯାହା ଚାହାଁନ୍ତି ପେଷ୍ଟ କରନ୍ତୁ — ଏକ କନସେପ୍ଟ, କାହାଣୀ, ସିନୋପସିସ୍, ବିଟ୍ ସିଟ୍, କିମ୍ବା ସ୍କ୍ରିନପ୍ଲେ — ଏହା ଆପଣଙ୍କୁ କହିବ ଏହା କେଉଁ ପର୍ଯ୍ୟାୟରେ ଅଛି।',
    aiMovieAnalyzePlaceholder: 'ଏଠାରେ ଯାହା ଚାହାଁନ୍ତି ପେଷ୍ଟ କରନ୍ତୁ…',
    aiMovieAnalyzeButton: 'ବିଶ୍ଳେଷଣ କରନ୍ତୁ',
    aiMovieAnalyzingLabel: 'ବିଶ୍ଳେଷଣ ହେଉଛି…',
    aiMovieStageResultConcept: 'ଏହା କନସେପ୍ଟ ପର୍ଯ୍ୟାୟରେ ଅଛି।',
    aiMovieStageResultStory: 'ଏହି କାହାଣୀ ଷ୍ଟୋରୀ ପର୍ଯ୍ୟାୟରେ ଅଛି।',
    aiMovieStageResultSynopsis: 'ଏହି କାହାଣୀ ସିନୋପସିସ୍ ପର୍ଯ୍ୟାୟରେ ଅଛି।',
    aiMovieStageResultBitsheet: 'ଏହି କାହାଣୀ ବିଟ୍ ସିଟ୍ ପର୍ଯ୍ୟାୟରେ ଅଛି।',
    aiMovieStageResultScreenplay: 'ଏହା ସ୍କ୍ରିନପ୍ଲେ ପର୍ଯ୍ୟାୟରେ ଅଛି।',
    aiMovieStageResultOther: 'ଏହାକୁ ସାଧାରଣ ପର୍ଯ୍ୟାୟଗୁଡ଼ିକ ମଧ୍ୟରୁ କୌଣସିଠାରେ ନିଶ୍ଚିତ ଭାବେ ରଖିହେଲା ନାହିଁ।',
    aiMovieProceedButton: 'ଆଗକୁ ବଢ଼ନ୍ତୁ',
    aiMovieBackfillingLabel: 'ପୂର୍ବ ପର୍ଯ୍ୟାୟଗୁଡ଼ିକ ପୂରଣ ହେଉଛି…',
    aiMovieBackfillNoteEarliest: 'ଏହା ପୂର୍ବରୁ ହିଁ ସବୁଠାରୁ ପ୍ରାରମ୍ଭିକ ପର୍ଯ୍ୟାୟ — ଏହା ପୂର୍ବରୁ ପୂରଣ କରିବାକୁ କିଛି ନାହିଁ।',
    aiMovieBackfillNoteOther: 'ଏକ ପର୍ଯ୍ୟାୟ ନିଶ୍ଚିତ ଭାବେ ଚିହ୍ନଟ ହୋଇପାରିଲା ନାହିଁ, ତେଣୁ ସ୍ୱୟଂଚାଳିତ ଭାବରେ କିଛି ପୂରଣ ହୋଇନାହିଁ।',
    aiMovieStoryLayerHeading: 'ଷ୍ଟୋରୀ',
    aiMovieSynopsisLayerHeading: 'ସିନୋପସିସ୍',
    aiMoviePlotLayerHeading: 'ପ୍ଲଟ୍',
    aiMovieCharacterArcLayerHeading: 'ଚରିତ୍ର ଯାତ୍ରା',
    aiMovieReferenceHeading: 'ରେଫରେନ୍ସ ସାମଗ୍ରୀ',
    aiMovieReferenceIntro: 'ଏଜେଣ୍ଟମାନଙ୍କୁ କାମ କରିବା ପାଇଁ ଅତିରିକ୍ତ ସୋର୍ସ ସାମଗ୍ରୀ ଦିଅନ୍ତୁ — ଆପଣଙ୍କ କାହାଣୀ ଆଧାରିତ ଏକ ପ୍ରକୃତ ବହି, କିମ୍ବା ଆପଣଙ୍କ ନିଜସ୍ୱ ଚରିତ୍ର/ସମ୍ପତ୍ତି/କଳା ବିବରଣୀ — ଏବଂ ସେମାନେ ନିଜେ କିଛି ଉଦ୍ଭାବନ କରିବା ପରିବର୍ତ୍ତେ ଏହାକୁ ପ୍ରାମାଣିକ ଭାବେ ଗ୍ରହଣ କରିବେ। ଆପଣ ଯାହା ଯୋଡ଼ନ୍ତି ତାହା ସ୍ୱୟଂଚାଳିତ ଭାବରେ ପଢ଼ି ସଜାଯାଏ, ହାତରେ ଲେବଲ୍ କରିବାକୁ କିଛି ନାହିଁ।',
    aiMovieReferencePastePlaceholder: 'ଏଠାରେ ପାଠ୍ୟ ପେଷ୍ଟ କରନ୍ତୁ…',
    aiMovieReferenceAddButton: 'ଯୋଡ଼ନ୍ତୁ',
    aiMovieReferenceAddingLabel: 'ଯୋଡ଼ୁଛି…',
    aiMovieReferenceUploadButton: 'ଫାଇଲ୍ ଅପଲୋଡ୍ କରନ୍ତୁ (PDF, Word, text, markdown, କିମ୍ବା ଏକାଧିକର .zip)',
    aiMovieReferenceUploadingLabel: 'ଅପଲୋଡ୍ ହେଉଛି…',
    aiMovieReferenceEmptyNote: 'ଏପର୍ଯ୍ୟନ୍ତ କିଛି ଯୋଡ଼ା ହୋଇନାହିଁ।',
    aiMovieReferenceRemoveTitle: 'ହଟାନ୍ତୁ',
    aiMovieReferenceUntitledLabel: 'ନାମହୀନ',
    aiMovieGenerateFromReferenceButton: 'ରେଫରେନ୍ସ ସାମଗ୍ରୀରୁ କାହାଣୀ ତିଆରି କରନ୍ତୁ',
    aiMovieGeneratingFromReferenceLabel: 'ତିଆରି ହେଉଛି…',
    aiMovieStageLabelStory: 'ଷ୍ଟୋରୀ',
    aiMovieStageLabelSynopsis: 'ସିନୋପସିସ୍',
    aiMovieStageLabelCharacterArc: 'ଚରିତ୍ରମାନେ',
    aiMovieStageLabelThreeAct: 'ତିନି-ଅଙ୍କ ଗଠନ',
    aiMovieStageLabelPlot: 'ବିଟ୍ ସିଟ୍',
    aiMovieStageLabelScreenplay: 'ସ୍କ୍ରିନପ୍ଲେ',
    aiMovieGenerateStageButton: (label) => `${label} ତିଆରି କରନ୍ତୁ`,
    aiMovieGeneratingStageLabel: 'ତିଆରି ହେଉଛି…',
    aiMovieAllStagesLockedNote: 'ସବୁକିଛି ଲକ୍ ହୋଇଗଲା — ଷ୍ଟୋରୀ, ସିନୋପସିସ୍, ଚରିତ୍ରମାନେ, ତିନି-ଅଙ୍କ ଗଠନ, ବିଟ୍ ସିଟ୍, ଏବଂ ସ୍କ୍ରିନପ୍ଲେ ସବୁ ଅନୁମୋଦିତ।',
    aiMovieThreeActTurningPointLabel: 'ମୋଡ଼ ବିନ୍ଦୁ',
    aiMovieDeleteProjectButton: 'ଡିଲିଟ୍ କରନ୍ତୁ',
    aiMovieDeleteProjectConfirm: 'ଏହି AI Movie ପ୍ରୋଜେକ୍ଟକୁ ସବୁଦିନ ପାଇଁ ଡିଲିଟ୍ କରିବେ? ଏହା ପୂର୍ବବତ୍ ହୋଇପାରିବ ନାହିଁ।',
    aiMovieSeedAkhadaButton: 'ନୂଆ ଷ୍ଟୋରୀ: Akhada (ଅପଲୋଡ୍ ହୋଇଥିବା ଫାଇଲ୍‌ରୁ)',
    aiMovieSeedingAkhadaLabel: 'ତିଆରି ହେଉଛି…',
    aiMovieFillAkhadaStagesButton: 'ଆପଣଙ୍କ ଫାଇଲ୍‌ରୁ ସିନୋପସିସ୍ → ବିଟ୍ ସିଟ୍ ପୂରଣ କରନ୍ତୁ (ପୁନଃ-ସମୀକ୍ଷା ଛାଡ଼ନ୍ତୁ)',
    aiMovieFillingAkhadaStagesLabel: 'ପୂରଣ ହେଉଛି…',
    aiMovieFillBeatDurationsButton: 'ଆପଣଙ୍କ ଫାଇଲ୍‌ରୁ ସଠିକ୍ ବିଟ୍ ଅବଧି ସିଙ୍କ୍ କରନ୍ତୁ',
    aiMovieFillingBeatDurationsLabel: 'ସିଙ୍କ୍ ହେଉଛି…',
    aiMovieFillBeatDurationsResultNote: (updated, total) => `${total} ବିଟ୍‌ ମଧ୍ୟରୁ ${updated}ଟି ଅବଧି ସଠିକ୍ କରାଗଲା।`,
    aiMovieScreenplayGenerateButton: 'ସ୍କ୍ରିନପ୍ଲେ ତିଆରି କରନ୍ତୁ',
    aiMovieScreenplayStartingLabel: 'ଆରମ୍ଭ ହେଉଛି…',
    aiMovieScreenplayBeatWritingLabel: 'ଏହି ବିଟ୍‌ର ଦୃଶ୍ୟ ଲେଖାଯାଉଛି…',
    aiMovieScreenplayBeatErrorLabel: 'ଏହି ବିଟ୍ ତିଆରି କରିବାରେ କିଛି ଭୁଲ ହେଲା।',
    aiMovieScreenplayRetryButton: 'ପୁଣି ଚେଷ୍ଟା କରନ୍ତୁ',
    aiMovieBeatShortNote: 'ଏହି ବିଟ୍ ବିଟ୍ ସିଟ୍‌ର ସମୟଠାରୁ ଛୋଟ — ତଳେ "ଲକ୍ଷ୍ୟ ପର୍ଯ୍ୟନ୍ତ ବଢ଼ାନ୍ତୁ" ବ୍ୟବହାର କରନ୍ତୁ (ଲେଖାଯାଇଥିବା ସବୁକିଛି ରହିବ)।',
    aiMovieBeatLongNote: 'ଏହି ବିଟ୍ ବିଟ୍ ସିଟ୍‌ର ସମୟଠାରୁ ଲମ୍ବା — ଛୋଟ କରିବାକୁ ଏକ ଦୃଶ୍ୟରେ "ପରିବର୍ତ୍ତନ ପାଇଁ ଅନୁରୋଧ" ବ୍ୟବହାର କରନ୍ତୁ।',
    aiMovieDoctorButton: 'ସ୍କ୍ରିପ୍ଟ ଡକ୍ଟର',
    aiMovieDoctorRerunButton: 'ସ୍କ୍ରିପ୍ଟ ଡକ୍ଟର ପୁଣି ଚଲାନ୍ତୁ',
    aiMovieDoctorRunningLabel: 'ଏହି ବିଟ୍ ସମୀକ୍ଷା ହେଉଛି…',
    aiMovieDoctorNoNotes: 'ଏହି ବିଟ୍‌ରେ କୌଣସି ପ୍ରକୃତ ସମସ୍ୟା ମିଳିଲା ନାହିଁ।',
    aiMovieDoctorMajor: 'ବଡ଼',
    aiMovieDoctorMinor: 'ଛୋଟ',
    aiMovieDoctorSceneLabel: (n) => `ଦୃଶ୍ୟ ${n}`,
    aiMovieDoctorWholeBeatLabel: 'ସମ୍ପୂର୍ଣ୍ଣ ବିଟ୍',
    aiMovieDoctorCategoryLabels: { pacing: 'ଗତି', story_logic: 'କାହାଣୀ ତର୍କ', continuity: 'ନିରନ୍ତରତା', character: 'ଚରିତ୍ର', setup_payoff: 'ସେଟଅପ୍ / ପେଅଫ୍', world_rules: 'ଦୁନିଆର ନିୟମ', emotion: 'ଭାବନା', interval: 'ଇଣ୍ଟରଭାଲ୍' },
    aiMovieDoctorFixLabel: 'ସମାଧାନ',
    aiMovieDoctorApplyButton: 'ଏହି ସମାଧାନ ଲାଗୁ କରନ୍ତୁ',
    aiMovieDoctorApplyingLabel: 'ଲାଗୁ ହେଉଛି…',
    aiMovieDoctorAppliedLabel: '✓ ଲାଗୁ ହେଲା',
    aiMovieDoctorSceneChangedLabel: 'ସମୀକ୍ଷା ପରେ ଏହି ଦୃଶ୍ୟ ବଦଳିଛି — ସ୍କ୍ରିପ୍ଟ ଡକ୍ଟର ପୁଣି ଚଲାନ୍ତୁ।',
    aiMovieDoctorUseInRequestChangesButton: 'ପରିବର୍ତ୍ତନ ଅନୁରୋଧରେ ବ୍ୟବହାର କରନ୍ତୁ',
    aiMovieDoctorWholeBeatWarning: 'ଏହା ସମ୍ପୂର୍ଣ୍ଣ ବିଟ୍ ପୁଣି ଲେଖେ — ଏହାର ଦୃଶ୍ୟ ଓ ସଂଳାପ ବଦଳିଯିବ। ଇଚ୍ଛା ହେଲେ ସମାଧାନ ସମ୍ପାଦନ କରି Submit କରନ୍ତୁ।',
    aiMovieSongSheetLabel: 'ଗୀତ',
    aiMovieWriteSongSheetButton: 'ଗୀତ ସିଟ୍ ଲେଖନ୍ତୁ',
    aiMovieRewriteSongSheetButton: 'ଗୀତ ସିଟ୍ ପୁଣି ଲେଖନ୍ତୁ',
    aiMovieWritingSongSheetLabel: 'ଗୀତ ସିଟ୍ ଲେଖାଯାଉଛି…',
    aiMovieSongSituationLabel: 'ପରିସ୍ଥିତି',
    aiMovieSongPurposeLabel: 'କ’ଣ ବଦଳେ',
    aiMovieSongMoodLabel: 'ମୁଡ୍',
    aiMovieSongMusicLabel: 'ସଙ୍ଗୀତ',
    aiMovieSongSingersLabel: 'ଗାୟକ',
    aiMovieSongLyricistBriefLabel: 'ଗୀତିକାରଙ୍କ ପାଇଁ ବ୍ରିଫ୍',
    aiMovieSongPicturizationLabel: 'କିପରି ଚିତ୍ରାୟିତ ହେବ',
    aiMovieSetIntervalButton: (minutes) => (minutes ? `ଏହି ବିଟ୍ ପରେ ଇଣ୍ଟରଭାଲ୍ (${minutes} ମିନିଟ୍ ରେ)` : 'ଏହି ବିଟ୍ ପରେ ଇଣ୍ଟରଭାଲ୍'),
    aiMovieRemoveIntervalButton: 'ଇଣ୍ଟରଭାଲ୍ ହଟାନ୍ତୁ',
    aiMovieIntervalMarker: '— ଏହି ବିଟ୍ ପରେ ଇଣ୍ଟରଭାଲ୍ —',
    aiMovieScenePurposeLabels: { plot_advancing: 'କାହାଣୀ', character_revealing: 'ଚରିତ୍ର', both: 'କାହାଣୀ + ଚରିତ୍ର' },
    aiMovieScreenplayPdfButton: (lang) => `ସ୍କ୍ରିନପ୍ଲେ PDF ଡାଉନଲୋଡ୍ କରନ୍ତୁ (${lang === 'hi' ? 'ହିନ୍ଦୀ' : 'ଇଂରାଜୀ'})`,
    aiMovieExtendToTargetButton: (target) => `${aiMovieDurationText(target, 'ସେକେଣ୍ଡ', 'ମିନିଟ୍')} ପର୍ଯ୍ୟନ୍ତ ବଢ଼ାନ୍ତୁ`,
    aiMovieExtendingToTargetLabel: 'ଏହି ବିଟ୍ ବଢ଼ାଯାଉଛି…',
    aiMovieExtendToTargetNote: "ଲେଖାଯାଇଥିବା ପ୍ରତ୍ୟେକ ଦୃଶ୍ୟ ଓ ସଂଳାପ ରହିବ — ବିଟ୍ ସିଟ୍‌ର ସମୟ ପର୍ଯ୍ୟନ୍ତ କେବଳ ଅଧିକ ସ୍କ୍ରିନପ୍ଲେ ଯୋଡ଼ାଯିବ (ପ୍ରଥମେ ସଂଳାପ, ତା'ପରେ ନୂଆ ଦୃଶ୍ୟ)।",
    aiMovieScreenplayBeatOfLabel: (index, total) => `ବିଟ୍ ${index} / ${total}`,
    aiMovieScreenplayAllApprovedNote: 'ସମ୍ପୂର୍ଣ୍ଣ ସ୍କ୍ରିନପ୍ଲେ ଡ୍ରାଫ୍ଟ ସରିଲା — ପ୍ରତ୍ୟେକ ବିଟ୍ ଅନୁମୋଦିତ।',
    aiMovieReviseSceneButton: 'ପରିବର୍ତ୍ତନ ପାଇଁ ଅନୁରୋଧ',
    aiMovieReviseSceneCancelButton: 'ବାତିଲ୍',
    aiMovieReviseScenePlaceholder: 'ଇଚ୍ଛାଧୀନ — କଣ ବଦଳାଇବେ କୁହନ୍ତୁ, ଯଥା "ଏହାକୁ ଲମ୍ବା କରନ୍ତୁ" (ଖାଲି ଛାଡ଼ିଲେ AI ନିଜେ ଉନ୍ନତ କରିବ)',
    aiMovieReviseSceneSubmitButton: 'ଦାଖଲ କରନ୍ତୁ',
    aiMovieRevisingSceneLabel: 'ପରିବର୍ତ୍ତନ ହେଉଛି…',
    aiMovieSceneDurationLabel: (minutes) => `ଅବଧି: ~${aiMovieDurationText(minutes, 'ସେକେଣ୍ଡ', 'ମିନିଟ୍')}`,
    aiMovieTotalRuntimeLabel: (total, target) => `ଆକଳିତ ସମୁଦାୟ: ${aiMovieDurationText(total, 'ସେକେଣ୍ଡ', 'ମିନିଟ୍')} (ଲକ୍ଷ୍ୟ: ${aiMovieDurationText(target, 'ସେକେଣ୍ଡ', 'ମିନିଟ୍')})`,
    aiMovieWriteDialogueButton: 'ସଂଳାପ ଲେଖନ୍ତୁ',
    aiMovieRewriteDialogueButton: 'ସଂଳାପ ପୁନଃ ଲେଖନ୍ତୁ',
    aiMovieDialogueCancelButton: 'ବାତିଲ୍',
    aiMovieDialoguePlaceholder: 'ଇଚ୍ଛାଧୀନ — ସଂଳାପ ପାଇଁ କୌଣସି ନିର୍ଦ୍ଦେଶ, ଯଥା "ଏହାକୁ ଏକ ଉତ୍ତେଜନାପୂର୍ଣ୍ଣ ବିବାଦ କରନ୍ତୁ" (ଖାଲି ଛାଡ଼ିଲେ AI ନିଜେ ନିଷ୍ପତ୍ତି ନେବ)',
    aiMovieBeatNarrationButton: 'ଏହି ସମ୍ପୂର୍ଣ୍ଣ ବିଟ୍ ପାଇଁ ବର୍ଣ୍ଣନା',
    scriptThemeLabel: 'ପୃଷ୍ଠାର ରଙ୍ଗ',
    movieScriptNotWrittenLabel: 'ଏପର୍ଯ୍ୟନ୍ତ ଲେଖାଯାଇନାହିଁ',
    movieScriptNotWrittenShort: 'ଲେଖାଯାଇନାହିଁ',
    movieScriptOutlineLabel: 'ରୂପରେଖ',
    movieScriptApproveFirstNote: 'ଦୃଶ୍ୟ ଲେଖିବା ଆରମ୍ଭ କରିବାକୁ ତଳେ ଦୃଶ୍ୟ ତାଲିକା ଅନୁମୋଦନ କରନ୍ତୁ।',
    movieScriptEditSubmitNote: 'Submit — AI ବନାନ, ବ୍ୟାକରଣ ଓ ଭାଷା ଠିକ୍ କରେ (ଆକ୍ସନ ଇଂରାଜୀରେ, ସଂଳାପ ଏହି ଦୃଶ୍ୟର ଭାଷାରେ), ଆପଣଙ୍କ ଶବ୍ଦ ଓ ଘଟଣା ରଖେ, ଏବଂ ନୂଆ ସଂସ୍କରଣ ଭାବେ ସେଭ୍ କରେ।',
    movieScriptCheckNote: 'ସ୍କ୍ରିପ୍ଟ ଲେଖା ସରିବା ପରେ: ପ୍ରତ୍ୟେକ ଲେଖାଯାଇଥିବା ଦୃଶ୍ୟର ବନାନ, ବ୍ୟାକରଣ ଓ ଭାଷା ଯାଞ୍ଚ କରେ।',
    movieScriptCheckConfirm: (scenes, calls) => `ସମ୍ପୂର୍ଣ୍ଣ ସ୍କ୍ରିପ୍ଟ ଯାଞ୍ଚ କରିବେ? ${scenes}ଟି ଦୃଶ୍ୟ — ପ୍ରାୟ ${calls}ଟି AI କଲ୍।`,
    movieScriptCheckRunningLabel: (done, total) => `ଦୃଶ୍ୟ ଯାଞ୍ଚ ହେଉଛି… ${done} / ${total || '…'}`,
    movieScriptCheckShowReport: (fixes, scenes) => `ରିପୋର୍ଟ ଦେଖନ୍ତୁ (${scenes}ଟି ଦୃଶ୍ୟରେ ${fixes}ଟି ସଂଶୋଧନ)`,
    movieScriptCheckSceneLabel: (number, heading) => `ଦୃଶ୍ୟ ${number}: ${heading}`,
    movieScriptCheckChangedNote: (count) => `${count}ଟି ଧାଡ଼ି ସଂଶୋଧିତ।`,
    movieBreakdownStaleNote: 'ସ୍କ୍ରିପ୍ଟ ବ୍ରେକଡାଉନ୍ ତିଆରି ହେବା ପରେ ସ୍କ୍ରିପ୍ଟ ବଦଳିଛି — Production ରେ ବ୍ରେକଡାଉନ୍ ପୁଣି ଚଲାନ୍ତୁ।',
    aiMovieScriptCheckButton: '✔ ସମ୍ପୂର୍ଣ୍ଣ ସ୍କ୍ରିପ୍ଟ ଯାଞ୍ଚ',
    aiMovieScriptCheckRunningLabel: (done, total) => `ବିଟ୍ ${Math.min(done + 1, total)} / ${total} ଯାଞ୍ଚ ହେଉଛି…`,
    aiMovieScriptCheckNote: 'ସ୍କ୍ରିପ୍ଟ ଲେଖା ସରିବା ପରେ: ପ୍ରତ୍ୟେକ ଲେଖାଯାଇଥିବା ବିଟ୍‌ର ବନାନ, ବ୍ୟାକରଣ ଓ ଭାଷା ହିନ୍ଦୀ ଓ ଇଂରାଜୀରେ ଯାଞ୍ଚ କରେ, ଆପଣଙ୍କ ବିଷୟବସ୍ତୁ ରଖେ।',
    aiMovieScriptCheckRunningNote: 'ପଛରେ ଚାଲୁଛି — ଆପଣ କାମ ଜାରି ରଖିପାରିବେ।',
    aiMovieScriptCheckDoneNote: (finishedAt, failed) => `ଶେଷ ସମ୍ପୂର୍ଣ୍ଣ ଯାଞ୍ଚ: ${finishedAt ? new Date(finishedAt).toLocaleString() : ''}${failed ? ` — ${failed}ଟି ବିଟ୍ ଯାଞ୍ଚ ହୋଇପାରିଲା ନାହିଁ` : ''}।`,
    aiMovieScriptCheckConfirm: (beats) => `ସମ୍ପୂର୍ଣ୍ଣ ସ୍କ୍ରିପ୍ଟ ଯାଞ୍ଚ କରିବେ? ${beats}ଟି ବିଟ୍ — ପ୍ରାୟ ${beats}ଟି AI କଲ୍, କିଛି ମିନିଟ୍ ଲାଗିବ।`,
    aiMovieScriptCheckShowReport: (fixes, beats) => `ରିପୋର୍ଟ ଦେଖନ୍ତୁ (${beats}ଟି ବିଟ୍‌ରେ ${fixes}ଟି ସଂଶୋଧନ)`,
    aiMovieScriptCheckHideReport: 'ରିପୋର୍ଟ ଲୁଚାନ୍ତୁ',
    aiMovieScriptCheckBeatLabel: (number, title) => `ବିଟ୍ ${number}: ${title ?? ''}`,
    aiMovieScriptCheckSceneLabel: (number) => `ଦୃଶ୍ୟ ${number}`,
    aiMovieScriptCheckBeatFailed: 'ଏହି ବିଟ୍ ଯାଞ୍ଚ ହୋଇପାରିଲା ନାହିଁ — ପୁଣି ଚଲାନ୍ତୁ।',
    scriptEditStartButton: '✎ ଦୃଶ୍ୟ ସମ୍ପାଦନ',
    scriptEditEditingNote: 'ପୃଷ୍ଠାରେ ସମ୍ପାଦନା ଚାଲିଛି — ସିଧା ସ୍କ୍ରିପ୍ଟରେ ଲେଖନ୍ତୁ, ତାପରେ ଦୃଶ୍ୟ ତଳେ Submit ଦବାନ୍ତୁ।',
    scriptEditDoubleClickHint: 'ଏହି ଦୃଶ୍ୟ ସମ୍ପାଦନ ପାଇଁ ଦୁଇଥର କ୍ଲିକ୍ କରନ୍ତୁ',
    sceneManageTitle: 'ଦୃଶ୍ୟ ଯୋଡ଼ନ୍ତୁ ବା ହଟାନ୍ତୁ',
    sceneAddBeforeButton: '＋ ଆଗରେ ଦୃଶ୍ୟ ଯୋଡ଼ନ୍ତୁ',
    sceneAddAfterButton: '＋ ପରେ ଦୃଶ୍ୟ ଯୋଡ଼ନ୍ତୁ',
    sceneDeleteButton: '🗑 ଦୃଶ୍ୟ ହଟାନ୍ତୁ',
    sceneDeleteConfirm: (number) => `ଦୃଶ୍ୟ ${number} ହଟାଇବେ? ଏହାର ସ୍କ୍ରିପ୍ଟ ସବୁଦିନ ପାଇଁ ଚାଲିଯିବ ଏବଂ ପରର ଦୃଶ୍ୟଗୁଡ଼ିକ ଗୋଟିଏ ଲେଖାଏଁ ଆଗକୁ ଆସିବ।`,
    sceneNewTitle: (number) => `ନୂଆ ଦୃଶ୍ୟ ${number}`,
    sceneNewIntExtLabel: 'ଭିତର ନା ବାହାର',
    sceneNewInt: 'INT (ଭିତର)',
    sceneNewExt: 'EXT (ବାହାର)',
    sceneNewLocationLabel: 'ସ୍ଥାନ',
    sceneNewLocationPlaceholder: 'ଯେମିତି: ମନ୍ଦିର ବେଢ଼ା',
    sceneNewTimeLabel: 'ସମୟ',
    sceneNewTimeOptions: { DAY: 'ଦିନ', NIGHT: 'ରାତି', MORNING: 'ସକାଳ', EVENING: 'ସନ୍ଧ୍ୟା' },
    sceneNewWhatLabel: "କ'ଣ ହୁଏ",
    sceneNewWhatPlaceholder: "ଏକ ବା ଦୁଇ ଧାଡ଼ି: କିଏ ଅଛି, କ'ଣ ହୁଏ, କେମିତି ଶେଷ ହୁଏ",
    sceneNewMinutesLabel: 'ଲମ୍ବ (ମିନିଟ୍)',
    sceneNewWriteAiButton: 'ଯୋଡ଼ି AI ରେ ଲେଖନ୍ତୁ',
    sceneNewBlankButton: 'ଖାଲି ଯୋଡ଼ନ୍ତୁ (ମୁଁ ଲେଖିବି)',
    sceneNewCancelButton: 'ବାତିଲ୍',
    sceneNewSavingLabel: 'ଯୋଡ଼ାଯାଉଛି…',
    sceneNewNoteAfterChange: 'ପରର ଦୃଶ୍ୟ ନମ୍ବର ବଦଳିଛି। ସ୍କ୍ରିପ୍ଟ ବ୍ରେକଡାଉନ୍ ବା ସୁଟିଂ ସିଡ୍ୟୁଲ୍ ଆଗରୁ ତିଆରି ହୋଇଥିଲେ, ସେଗୁଡ଼ିକୁ ପୁଣି ଦେଖନ୍ତୁ।',
    scriptEditHeadingLabel: 'ଦୃଶ୍ୟ ଶୀର୍ଷକ',
    scriptEditCharacterPlaceholder: 'ଚରିତ୍ର',
    scriptEditParentheticalPlaceholder: '(ଅଭିନୟ ଟିପ୍ପଣୀ — ଇଚ୍ଛାଧୀନ)',
    scriptEditLinePlaceholder: 'ସଂଳାପ…',
    scriptEditActionPlaceholder: 'ଆକ୍ସନ…',
    scriptEditActionShort: 'ଆକ୍ସନ',
    scriptEditDialogueShort: 'ସଂଳାପ',
    scriptEditAddActionButton: 'ଏହା ପରେ ଏକ ଆକ୍ସନ ଧାଡ଼ି ଯୋଡ଼ନ୍ତୁ',
    scriptEditAddDialogueButton: 'ଏହା ପରେ ଏକ ସଂଳାପ ଧାଡ଼ି ଯୋଡ଼ନ୍ତୁ',
    scriptEditRemoveButton: 'ଏହି ଧାଡ଼ି ହଟାନ୍ତୁ',
    scriptEditSubmitNote: 'Submit — AI ବନାନ, ବ୍ୟାକରଣ ଓ ଭାଷା ଠିକ୍ କରେ (ଯଥା ହିନ୍ଦୀ ସଂସ୍କରଣରେ ଲେଖାଯାଇଥିବା ଇଂରାଜୀ), ଆପଣଙ୍କ ଶବ୍ଦ ଓ ଘଟଣା ରଖେ, ଏବଂ ଅନ୍ୟ ଭାଷାକୁ ମେଳ କରେ।',
    scriptEditSubmitButton: 'Submit',
    scriptEditSubmittingLabel: 'ଆପଣଙ୍କ ଦୃଶ୍ୟ ଯାଞ୍ଚ ହେଉଛି…',
    scriptEditFixesTitle: "AI କ'ଣ ଠିକ୍ କଲା",
    scriptEditNoFixesNote: 'କିଛି ଠିକ୍ କରିବା ଦରକାର ନଥିଲା।',
    aiMovieStageNotOpenYetNote: 'ପୂର୍ବ ପର୍ଯ୍ୟାୟ ଅନୁମୋଦିତ ହେବା ପରେ ଏହି ପର୍ଯ୍ୟାୟ ଖୋଲିବ।',
    scriptScenesTitle: 'ଦୃଶ୍ୟଗୁଡ଼ିକ',
    scriptSelectedSceneTitle: (number) => `ଦୃଶ୍ୟ ${number}`,
    scriptAiWritingLabel: 'AI ଲେଖୁଛି…',
    aiMovieShortDuration: (minutes) => aiMovieDurationText(minutes, 'ସେକେଣ୍ଡ', 'ମିନିଟ୍'),
    scriptThemeLight: '☀ ହାଲୁକା',
    scriptThemeDark: '☾ ଗାଢ଼',
    aiMovieBeatNarrationNote: 'ଏହି ବିଟ୍‌ର ସମସ୍ତ ଦୃଶ୍ୟ ଦେଇ କ୍ରମରେ ବହୁଥିବା ଗୋଟିଏ ନିରନ୍ତର ବର୍ଣ୍ଣନାକାରୀ ଭଏସ୍-ଓଭର ଲେଖେ। ପୂର୍ବରୁ ଲେଖାଯାଇଥିବା ସଂଳାପ ରହିଯାଏ।',
    aiMovieBeatNarrationPlaceholder: 'ଏହି ବିଟ୍ ପାଇଁ ବର୍ଣ୍ଣନା ବିଷୟରେ ଲେଖନ୍ତୁ, ଯଥା "ଯୁଦ୍ଧ ଓ ପ୍ରଦୂଷଣ କିପରି ପୃଥିବୀକୁ ଖାଲି କଲା, ଏବଂ କେବଳ ଭଗବାନ ଓ ମନ୍ଦିର ରହିଗଲେ, ବର୍ଣ୍ଣନାକାରୀ କହନ୍ତି।"',
    aiMovieBeatNarrationSubmitButton: 'ବର୍ଣ୍ଣନା ଲେଖନ୍ତୁ',
    aiMovieBeatNarrationProgress: (scene, total) => `ବର୍ଣ୍ଣନା ଲେଖାଯାଉଛି — ଦୃଶ୍ୟ ${scene} / ${total}…`,
    aiMovieBeatNarrationSceneError: (scene, message) => `ଦୃଶ୍ୟ ${scene}: ${message}`,
    aiMovieDialogueSubmitButton: 'ସଂଳାପ ଲେଖନ୍ତୁ',
    aiMovieWritingDialogueLabel: 'ଲେଖାଯାଉଛି…',
    aiMovieNoDialogueNeededNote: 'ଏହି ଦୃଶ୍ୟ ପାଇଁ ସଂଳାପ ଆବଶ୍ୟକ ନାହିଁ।',
    formatQuestion: 'ଏହା ଏକ ଚଳଚ୍ଚିତ୍ର, ୱେବ ସିରିଜ୍ କିମ୍ବା ଭର୍ଟିକାଲ୍ ଡ୍ରାମା?',
    filmOption: 'ଚଳଚ୍ଚିତ୍ର',
    seriesOption: 'ୱେବ ସିରିଜ୍',
    verticalDramaOption: 'ଭର୍ଟିକାଲ୍ ଡ୍ରାମା',
    episodeCountLabel: 'ପର୍ବ ସଂଖ୍ୟା',
    episodeMinutesLabel: 'ପ୍ରତି ପର୍ବ ମିନିଟ୍',
    runtimeMinutesLabel: 'ସମୁଦାୟ ଅବଧି (ମିନିଟ୍)',
    buildPitchDeck: 'ପିଚ୍ ଡେକ୍ ତିଆରି କରନ୍ତୁ',
    buildingPitchDeck: 'ପିଚ୍ ଡେକ୍ ତିଆରି ହେଉଛି...',
    cancel: 'ବାତିଲ୍',
    storyHeading: 'କାହାଣୀ',
    premise: 'କାହାଣୀ ସାରାଂଶ',
    toneGenre: 'ଶୈଳୀ / ଧାରା',
    targetAudience: 'ଲକ୍ଷ୍ୟ ଦର୍ଶକ',
    highlightsHeading: 'ବିଶେଷତ୍ୱ',
    sponsorshipAngleHeading: 'ପ୍ରାୟୋଜକ ଦୃଷ୍ଟିକୋଣ',
    majorCharactersHeading: 'ମୁଖ୍ୟ ଚରିତ୍ର',
    emotionalCoreLabel: 'ଭାବନାତ୍ମକ ମୂଳ',
    conflictLabel: 'ସଂଘର୍ଷ',
    exportAsPdf: 'ପ୍ରେଜେଣ୍ଟେଶନ୍ ଡାଉନଲୋଡ୍ କରନ୍ତୁ',
    formatFilm: 'ପୂର୍ଣ୍ଣ ଚଳଚ୍ଚିତ୍ର',
    formatSeries: (count, minutes) => `ୱେବ ସିରିଜ୍ · ${count} ପର୍ବ × ${minutes} ମିନିଟ୍ ପ୍ରତି`,
    formatVertical: (count, minutes) => `ଭର୍ଟିକାଲ୍ ଡ୍ରାମା · ${count} ପର୍ବ × ${minutes} ମିନିଟ୍ ପ୍ରତି`,
    episodeBreakdown: 'ପର୍ବ ବିବରଣୀ',
    episodeLabel: 'ପର୍ବ',
    hookLabel: 'ହୁକ୍',
    genericError: 'କିଛି ଭୁଲ ହେଲା। ଦୟାକରି ଅଳ୍ପ ସମୟ ଅପେକ୍ଷା କରି ପୁନଃ ଚେଷ୍ଟା କରନ୍ତୁ।',
    breakdownTimedOutError: 'ଏହି ସ୍କ୍ରିପ୍ଟକୁ ବିଶ୍ଳେଷଣ କରିବାକୁ ଅସାଧାରଣ ସମୟ ଲାଗୁଛି। ଏହା ବୋଧହୁଏ ପଛରେ ଚାଲୁଛି — ଦୟାକରି କିଛି ମିନିଟ୍ ପରେ ଯାଞ୍ଚ କରନ୍ତୁ, କିମ୍ବା ପେଜ୍ ରିଫ୍ରେସ୍ କରନ୍ତୁ।',
    screenplayUploadedToast: 'ସ୍କ୍ରିପ୍ଟ ସଫଳତାର ସହିତ ଅପଲୋଡ୍ ହେଲା। ବ୍ରେକଡାଉନ୍ (ଚରିତ୍ର, ପ୍ରପର୍ଟି, ଲୋକେସନ୍ ଏବଂ ଅନ୍ୟାନ୍ୟ) ତିଆରି କରିବାକୁ ତଳେ "Analyze Script" କ୍ଲିକ୍ କରନ୍ତୁ।',
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
    classifyCastCategoriesButton: 'କାଷ୍ଟ ବର୍ଗ ଶ୍ରେଣୀକରଣ କରନ୍ତୁ',
    classifyingCastCategoriesLabel: 'ଶ୍ରେଣୀକରଣ ହେଉଛି...',
    classifyCastCategoriesHint: 'ସମ୍ପୂର୍ଣ୍ଣ ସ୍କ୍ରିପ୍ଟ ସ୍କାନ୍ କରି ପ୍ରତ୍ୟେକ ଚରିତ୍ରକୁ ଗୋଷ୍ଠୀରେ ବିଭକ୍ତ କରେ: ଲିଡ୍, ସାଇଡ୍‌କିକ୍, ଏକ୍ସଟ୍ରା/ଜୁନିଅର୍ (ସବୁ ସଂଳାପ ଥିବା ଭୂମିକା, କାହାଣୀରେ ଗୁରୁତ୍ୱ ଅନୁସାରେ), କିମ୍ବା ନନ୍-ସ୍ପିକିଙ୍ଗ୍ (ଉପସ୍ଥିତ କିନ୍ତୁ ନିରବ, କିମ୍ବା କେବଳ ଶୁଣାଯାଏ)।',
    castCategorySpeakingLabel: 'ସଂଳାପ ଥିବା / ମୁଖ୍ୟ କଳାକାର',
    castCategoryActionOnlyLabel: 'କେବଳ କାର୍ଯ୍ୟ (ସଂଳାପ ନାହିଁ)',
    castCategoryOffScreenLabel: 'ଅଫ୍-ସ୍କ୍ରିନ୍ / କେବଳ ସ୍ୱର (ସେଟ୍‌ରେ ଡକାଯାଏ ନାହିଁ)',
    castCategoryUnclassifiedLabel: 'ଏପର୍ଯ୍ୟନ୍ତ ଶ୍ରେଣୀକରଣ ହୋଇନାହିଁ',
    castTierLeadLabel: 'ମୁଖ୍ୟ ଚରିତ୍ର (Lead)',
    castTierSidekickLabel: 'ସାଇଡ୍‌କିକ୍ (Sidekick)',
    castTierExtraLabel: 'ଏକ୍ସଟ୍ରା / ଜୁନିଅର୍ ଆର୍ଟିଷ୍ଟ',
    castTierNonSpeakingLabel: 'ନନ୍-ସ୍ପିକିଙ୍ଗ୍ ଚରିତ୍ର',
    classifyEpisodeNumbersButton: 'ଏପିସୋଡ୍ ନମ୍ବର ଟ୍ୟାଗ୍ କରନ୍ତୁ',
    classifyingEpisodeNumbersLabel: 'ଏପିସୋଡ୍ ଟ୍ୟାଗ୍ ହେଉଛି...',
    classifyEpisodeNumbersHint: 'ସମ୍ପୂର୍ଣ୍ଣ ସ୍କ୍ରିପ୍ଟ ସ୍କାନ୍ କରି ପ୍ରତ୍ୟେକ ଚରିତ୍ର, ଲୋକେସନ୍, ପ୍ରପ୍, ପୋଷାକ ଏବଂ କଳା ବିଭାଗ ବିଷୟ କେଉଁ ଏପିସୋଡ୍(ଗୁଡ଼ିକ)ରେ ଆସୁଛି ତାହା ଚିହ୍ନଟ କରେ।',
    episodeNumbersPrefix: 'Ep',
    juniorArtistCoordinatorHeading: 'ଜୁନିଅର୍ ଆର୍ଟିଷ୍ଟ କୋଅର୍ଡିନେଟର୍',
    juniorArtistCoordinatorHint: 'ତଳେ ଥିବା ସବୁ ଏକ୍ସଟ୍ରା/ଜୁନିଅର୍ ଚରିତ୍ରକୁ କାଷ୍ଟ ହୋଇଥିବା ଭାବରେ ଚିହ୍ନଟ କରିବାକୁ ଏଠି ଗୋଟିଏ କୋଅର୍ଡିନେଟର୍ ଯୋଡ଼ନ୍ତୁ — ପ୍ରତ୍ୟେକଙ୍କୁ ଅଲଗା ଅଲଗା କାଷ୍ଟ କରିବାର ଆବଶ୍ୟକତା ନାହିଁ।',
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
    structureModelLabel: 'ଗଠନ:',
    structureModelNames: {
      three_act: 'ତିନି ଅଙ୍କ',
      five_act: 'ପାଞ୍ଚ ଅଙ୍କ',
      heros_journey: 'ନାୟକର ଯାତ୍ରା (Hero\'s Journey)',
      kishotenketsu: 'କିଶୋତେନକେତ୍ସୁ (ଚାରି ଭାଗ, ଗୋଟେ ମୋଡ଼ ସହ)',
      non_linear: 'ଆଗପଛ କାହାଣୀ (Non-linear)',
      ensemble: 'ଏକାଧିକ ନାୟକ (Ensemble)',
      real_time: 'ରିଅଲ୍-ଟାଇମ୍',
    },
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
    intExtLabel: 'ଭିତର/ବାହାର',
    locationLabel: 'ସ୍ଥାନ',
    descriptionLabel: 'ବିବରଣୀ',
    movingScenesToDayLabel: 'ଏହି ଦୃଶ୍ୟଗୁଡ଼ିକୁ ଏହି ଦିନକୁ ଘୁଞ୍ଚାଉଛି',
    affectedScenesHeading: 'ଏହା ପ୍ରଭାବିତ କରୁଥିବା ଦୃଶ୍ୟ:',
    dayLabel: 'ଦିନ',
    nightLabel: 'ରାତି',
    approveSceneListButton: 'ଦୃଶ୍ୟ ତାଲିକା ଅନୁମୋଦନ କରନ୍ତୁ',
    sceneListApprovedBadge: '✅ ଦୃଶ୍ୟ ତାଲିକା ଅନୁମୋଦିତ',
    sceneListFeedbackPlaceholder: 'ଆପଣ କଣ ପରିବର୍ତ୍ତନ ଚାହୁଁଛନ୍ତି?',
    approxMinutesUnit: (minutes) => `~${aiMovieDurationText(minutes, 'ସେକେଣ୍ଡ', 'ମିନିଟ୍')}`,
    totalRuntimeLabel: (total, target) => `ଆକଳିତ ସମୁଦାୟ: ${aiMovieDurationText(total, 'ସେକେଣ୍ଡ', 'ମିନିଟ୍')} (ଲକ୍ଷ୍ୟ: ${aiMovieDurationText(target, 'ସେକେଣ୍ଡ', 'ମିନିଟ୍')})`,
    runtimeMismatchNote: 'ଏହା ଲକ୍ଷ୍ୟ ଅବଧିଠାରୁ ଭିନ୍ନ ଅଛି — ତଳେ "ପରିବର୍ତ୍ତନ ପାଇଁ ଅନୁରୋଧ" ବ୍ୟବହାର କରନ୍ତୁ।',
    writeSceneButton: 'ଏହି ଦୃଶ୍ୟ ଲେଖନ୍ତୁ',
    generatingScreenplayScene: 'ଦୃଶ୍ୟ ଲେଖାଯାଉଛି...',
    screenplayCharactersLabel: 'ଚରିତ୍ର',
    dialogueLanguageEnglish: 'ସଂଳାପ: ଇଂରାଜୀ',
    dialogueLanguageOdia: 'ସଂଳାପ: ଓଡ଼ିଆ',
    dialogueLanguageHindi: 'ସଂଳାପ: ହିନ୍ଦୀ',
    floatingAgentTitle: 'ଅଟୋ ସ୍କ୍ରିନପ୍ଲେ ଏଜେଣ୍ଟ',
    floatingAgentConceptPlaceholder: 'ଆପଣଙ୍କର କାହାଣୀ ଧାରଣା ବର୍ଣ୍ଣନା କରନ୍ତୁ...',
    floatingAgentStartButton: 'ଆରମ୍ଭ କରନ୍ତୁ',
    floatingAgentStarting: 'ଆରମ୍ଭ ହେଉଛି...',
    floatingAgentStageLabel: 'ପର୍ଯ୍ୟାୟ',
    floatingAgentStageNames: {
      starting: 'ଆରମ୍ଭ ହେଉଛି',
      storylines: 'କାହାଣୀ ଧାରା ତିଆରି ହେଉଛି',
      'pitch-deck': 'ପିଚ୍ ଡେକ୍ ଲେଖାଯାଉଛି',
      'character-sheet': 'ଚରିତ୍ର ତିଆରି ହେଉଛି',
      'three-act': 'କାହାଣୀ ଗଠନ ହେଉଛି',
      'bit-sheet': 'ବିଟ୍ ସିଟ୍ ତିଆରି ହେଉଛି',
      'scene-list': 'ଦୃଶ୍ୟ ତାଲିକା ଲେଖାଯାଉଛି',
      screenplay: 'ସ୍କ୍ରିନପ୍ଲେ ଲେଖାଯାଉଛି',
      'sequence-review': 'ସ୍କ୍ରିପ୍ଟ ଏଡିଟର ଦୃଶ୍ୟ ଗୁଚ୍ଛ ଅନୁସାରେ ସ୍କ୍ରିନପ୍ଲେ ଯାଞ୍ଚ କରୁଛନ୍ତି',
      'quality-pass': 'ଚୂଡ଼ାନ୍ତ ଗୁଣବତ୍ତା ଯାଞ୍ଚ — ପୁନରାବୃତ୍ତି ଯାଞ୍ଚ ହେଉଛି',
      'language-check': 'ଚୂଡ଼ାନ୍ତ ଭାଷା ଯାଞ୍ଚ — ବ୍ୟାକରଣ ଓ ସ୍ୱାଭାବିକ ସଂଳାପ',
      'story-brain': 'ସ୍ଟୋରି ବ୍ରେନ୍ କାହାଣୀ ଡିଜାଇନ୍ କରୁଛି',
      'story-bible': 'ସ୍ଟୋରି ବାଇବଲ୍ — ଆପଣଙ୍କ ଅନୁମୋଦନ',
      'story-bible-approved': 'ସ୍ଟୋରି ବାଇବଲ୍ ଅନୁମୋଦିତ',
      done: 'ସମାପ୍ତ',
    },
    floatingAgentStatusAwaiting: 'ଆପଣଙ୍କୁ ଅପେକ୍ଷା କରୁଛି',
    floatingAgentStatusApproved: 'ଅନୁମୋଦିତ',
    bibleReadyLabel: 'ସ୍ଟୋରି ବାଇବଲ୍ ପ୍ରସ୍ତୁତ। ପଢ଼ନ୍ତୁ, ତା\'ପରେ ଅନୁମୋଦନ କରନ୍ତୁ କିମ୍ବା ନୋଟ୍ ଦିଅନ୍ତୁ।',
    bibleCriticsPassed: 'ସମୀକ୍ଷକମାନେ ପାସ୍ କରିଛନ୍ତି',
    bibleCriticsNeedInput: 'ସବୁ ସମୀକ୍ଷକ ୮ରେ ପହଞ୍ଚିନାହାନ୍ତି — ବାକି ସମସ୍ୟା ଦେଖନ୍ତୁ',
    bibleCriticDoctor: 'ସ୍କ୍ରିପ୍ଟ ଡାକ୍ତର',
    bibleCriticAudience: 'ଦର୍ଶକ',
    bibleCriticCulture: 'ସଂସ୍କୃତି',
    bibleQuestionLabel: 'ଯେଉଁ ପ୍ରଶ୍ନ ଦର୍ଶକଙ୍କୁ ବାନ୍ଧି ରଖେ',
    bibleOpeningLabel: 'ଆରମ୍ଭ ଆଉ ତା\'ର ଶେଷ ହୁକ୍',
    bibleClimaxLabel: 'କ୍ଲାଇମାକ୍ସ',
    bibleFinalImageLabel: 'ଶେଷ ଦୃଶ୍ୟ',
    bibleEpisodeHooksLabel: 'ପ୍ରତି ଏପିସୋଡ୍ କେମିତି ଶେଷ ହୁଏ',
    bibleSequenceHooksLabel: 'ପ୍ରତି ସିକ୍ୱେନ୍ସ କେମିତି ଶେଷ ହୁଏ',
    bibleOpenProblemsLabel: (count) => `ସମୀକ୍ଷକମାନେ ଦେଖୁଥିବା ବାକି ସମସ୍ୟା (${count})`,
    bibleOpenFullButton: 'ପୂରା ସ୍ଟୋରି ବାଇବଲ୍ ଖୋଲନ୍ତୁ',
    bibleApproveButton: 'ଅନୁମୋଦନ କରନ୍ତୁ',
    bibleNotePlaceholder: 'ଆପଣଙ୍କ ନୋଟ୍ — କ\'ଣ ବଦଳିବା ଦରକାର?',
    bibleSendNoteButton: 'ମୋ ନୋଟ୍ ଅନୁସାରେ ବଦଳାନ୍ତୁ',
    bibleSending: 'ପଠାଯାଉଛି...',
    bibleApprovedLabel: 'ଅନୁମୋଦିତ — ଏହି ସ୍ଟୋରି ବାଇବଲ୍‌ରୁ ସ୍କ୍ରିପ୍ଟ ଲେଖାଯାଉଛି।',
    floatingAgentSecondsSuffix: 'ସେ',
    floatingAgentFilmMinutesLabel: 'ଫିଲ୍ମର ଲମ୍ବ (ମିନିଟ୍)',
    floatingAgentStatusWorking: 'କାମ ଚାଲିଛି',
    floatingAgentStatusStopped: 'ବନ୍ଦ ହୋଇଗଲା',
    floatingAgentTimelineTitle: 'ପର୍ଯ୍ୟାୟ',
    floatingAgentNotesTitle: "ଏଜେଣ୍ଟମାନେ କ'ଣ କହିଲେ",
    floatingAgentOpenProjectButton: 'ମୁଭି ସ୍କ୍ରିନରେ ଖୋଲନ୍ତୁ',
    floatingAgentDoneLabel: 'ଆପଣଙ୍କର ସ୍କ୍ରିନପ୍ଲେ ପ୍ରସ୍ତୁତ।',
    floatingAgentDownloadButton: 'ସ୍କ୍ରିନପ୍ଲେ ଡାଉନଲୋଡ୍ କରନ୍ତୁ',
    floatingAgentTranslateDownloadButton: 'ଅନୁବାଦ କରି ଡାଉନଲୋଡ୍ କରନ୍ତୁ',
    floatingAgentFormatPdf: 'PDF',
    floatingAgentFormatWord: 'ୱାର୍ଡ (.docx)',
    floatingAgentNewRunButton: 'ନୂଆ ରନ୍ ଆରମ୍ଭ କରନ୍ତୁ',
    floatingAgentResumeButton: 'ଯେଉଁଠି ବିଫଳ ହେଲା ସେଠାରୁ ପୁନଃ ଆରମ୍ଭ କରନ୍ତୁ',
    floatingAgentResuming: 'ପୁନଃ ଆରମ୍ଭ ହେଉଛି...',
    screenplayFeedbackPlaceholder: 'ଆପଣ ଏହି ଦୃଶ୍ୟରେ କଣ ପରିବର୍ତ୍ତନ ଚାହୁଁଛନ୍ତି?',
    screenplayCompleteBanner: '🎬 ସମ୍ପୂର୍ଣ୍ଣ ସ୍କ୍ରିନପ୍ଲେ ତିଆରି ହୋଇଗଲା! ଏହି ଲକ୍ ହୋଇଥିବା ସଂରଚନା ଏବଂ ଅନ୍ତିମ ସ୍କ୍ରିନପ୍ଲେ ପରବର୍ତ୍ତୀ ପର୍ଯ୍ୟାୟକୁ ହସ୍ତାନ୍ତର ପାଇଁ ପ୍ରସ୍ତୁତ।',
    screenplayProgressLabel: (drafted, total) => `ସ୍କ୍ରିନପ୍ଲେ ପ୍ରଗତି: ${drafted} / ${total} ଦୃଶ୍ୟ ଲେଖାଯାଇଛି`,
    productionHeading: 'ପ୍ରଡକ୍ସନ୍ ମେନେଜମେଣ୍ଟ',
    scriptBreakdownHeading: 'ସ୍କ୍ରିପ୍ଟ ବ୍ରେକଡାଉନ୍',
    autoBackfillInProgressNote: 'କାଷ୍ଟ ଟିଅର୍ ଏବଂ ଏପିସୋଡ୍ ନମ୍ବର ପଛରେ ଅପଡେଟ୍ ହେଉଛି — ଏଥିରେ କିଛି ମିନିଟ୍ ଲାଗିପାରେ। ସମାପ୍ତ ହେଲେ ଏହି ପେଜ୍ ଆପେ ରିଫ୍ରେସ୍ ହେବ, କିଛି କ୍ଲିକ୍ କରିବାର ଆବଶ୍ୟକତା ନାହିଁ।',
    autoBackfillRetryingNote: 'ପଛରେ ହୋଇଥିବା ଅପଡେଟ୍ ପ୍ରୟାସ ବିଫଳ ହୋଇଥିଲା — ଏବେ ପୁନଃ ଚେଷ୍ଟା ହେଉଛି। ସଫଳ ହେଲେ ଏହି ପେଜ୍ ରିଫ୍ରେସ୍ ହେବ।',
    generateBreakdownButton: 'ସ୍କ୍ରିପ୍ଟ ବିଶ୍ଳେଷଣ କରନ୍ତୁ',
    cancelBreakdownButton: 'ବାତିଲ୍ କରି ପୁନଃ ଚେଷ୍ଟା କରନ୍ତୁ',
    generatingBreakdownLabel: 'ସ୍କ୍ରିପ୍ଟ ବିଶ୍ଳେଷଣ ହେଉଛି...',
    generateAdSheetButton: 'AD ସିନ୍ ବ୍ରେକଡାଉନ୍ ସିଟ୍ ତିଆରି କରନ୍ତୁ',
    generatingAdSheetLabel: 'AD ସିଟ୍ ତିଆରି ହେଉଛି...',
    downloadAdSheetLabel: 'AD ସିନ୍ ବ୍ରେକଡାଉନ୍ ସିଟ୍ ଡାଉନଲୋଡ୍ କରନ୍ତୁ',
    artistListHeading: 'କଳାକାର ତାଲିକା',
    locationListHeading: 'ସ୍ଥାନ ତାଲିକା',
    propsHeading: 'ସାମଗ୍ରୀ ତାଲିକା (ପ୍ରପ୍ସ)',
    costumesHeading: 'ପୋଷାକ ପରିବର୍ତ୍ତନ',
    artHeading: 'କଳା ବିଭାଗ ମନ୍ତବ୍ୟ',
    propsAndArtHeading: 'ସାମଗ୍ରୀ ଓ କଳା ବିଭାଗ ମନ୍ତବ୍ୟ',
    costumeRecommendationsHeading: 'ପ୍ରସ୍ତାବିତ ପୋଷାକ ପରିମାଣ',
    generateCostumeRecommendationsButton: 'ପୋଷାକ ପରିମାଣ ପ୍ରସ୍ତାବ କରନ୍ତୁ',
    generatingCostumeRecommendationsLabel: 'ଦୃଶ୍ୟ ବିଶ୍ଳେଷଣ ହେଉଛି…',
    costumeApprovedBadge: '✅ ଅନୁମୋଦିତ — ଲକ୍ ହୋଇଛି',
    regenerateCostumeRecommendationButton: 'ପୁନଃ ତିଆରି କରନ୍ତୁ',
    editCostumeSetsButton: 'ପୋଷାକ ଯୋଡ଼ନ୍ତୁ / ହଟାନ୍ତୁ',
    removeCostumeSetButton: 'ହଟାନ୍ତୁ',
    addCostumeSetButton: 'ଆଉ ଏକ ଯୋଡ଼ନ୍ତୁ',
    approveCostumeButton: 'ଅନୁମୋଦନ କରନ୍ତୁ',
    costumeSetCategoryPlaceholder: 'ପୋଷାକ ବର୍ଗ (ଉଦାହରଣ: ଅଫିସ୍ ପୋଷାକ)',
    costumeSetQuantityPlaceholder: 'ପରିମାଣ',
    costumeSetReasonPlaceholder: 'କାରଣ (ଇଚ୍ଛାଧୀନ)',
    costumeRecommendationsNeedsAdSheetHint: 'ପ୍ରଥମେ AD ଦୃଶ୍ୟ ବିଭାଜନ ସିଟ୍ ତିଆରି କରନ୍ତୁ — ପ୍ରତ୍ୟେକ ଚରିତ୍ର କେଉଁ ଦୃଶ୍ୟରେ ଅଛନ୍ତି ଜାଣିବାକୁ ଏହା ଦରକାର।',
    downloadLabel: 'ଡାଉନଲୋଡ୍ କରନ୍ତୁ',
    downloadFormatPdf: 'PDF',
    downloadFormatExcel: 'Excel',
    downloadFormatPpt: 'PowerPoint',
    pitchDeckDownloadHint: 'ପ୍ରେଜେଣ୍ଟେସନ୍ ଡାଉନଲୋଡ୍ ଅନଲକ୍ କରିବାକୁ ପ୍ରଥମେ ଚରିତ୍ର ତିଆରି କରନ୍ତୁ — ସେମାନଙ୍କ ବିବରଣୀ ଏଥିରେ ଅନ୍ତର୍ଭୁକ୍ତ ହେବ।',
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
    dayMasterBreakdownLabel: 'ଦିନ ବିଭାଜନ — ମାଷ୍ଟର',
    dayArtistBreakdownLabel: 'କଳାକାର ବିଭାଜନ',
    dayLocationBreakdownLabel: 'ସ୍ଥାନ ବିଭାଜନ',
    dayCostumeBreakdownLabel: 'ପୋଷାକ ବିଭାଜନ',
    dayPropertiesBreakdownLabel: 'ସାମଗ୍ରୀ ବିଭାଜନ',
    dayCallSheetLabel: 'କଲ୍ ସିଟ୍',
    costumeLabel: 'ପୋଷାକ',
    propertiesLabel: 'ପ୍ରପର୍ଟି',
    adRemarkLabel: 'AD ମନ୍ତବ୍ୟ',
    editSceneButton: 'ସମ୍ପାଦନା',
    saveButton: 'ସେଭ୍ କରନ୍ତୁ',
    savingLabel: 'ସେଭ୍ ହେଉଛି…',
    uploadHandwrittenNoteButton: 'ହସ୍ତଲିଖିତ ନୋଟ୍ ଅପଲୋଡ୍ କରନ୍ତୁ (ଫଟୋ)',
    interpretingHandwrittenNoteLabel: 'ଫଟୋ ପଢ଼ାଯାଉଛି…',
    handwrittenNoteHint: 'ଏକ ହସ୍ତଲିଖିତ ନୋଟ୍ (ପ୍ରପର୍ଟି, ପୋଷାକ ଟିପ୍ପଣୀ, ମନ୍ତବ୍ୟ) ର ଏକ ଫଟୋ ନିଅନ୍ତୁ କିମ୍ବା ଅପଲୋଡ୍ କରନ୍ତୁ — କିଛି ପରିବର୍ତ୍ତନ ହେବା ପୂର୍ବରୁ ଏହା ପଢ଼ାଯାଇ ଆପଣଙ୍କୁ ନିଶ୍ଚିତ କରିବାକୁ ଦେଖାଯିବ।',
    couldNotPlaceLabel: 'ରଖାଯାଇପାରିଲା ନାହିଁ — ହାତରେ ଯୋଡ଼ନ୍ତୁ',
    confirmApplyButton: 'ନିଶ୍ଚିତ କରନ୍ତୁ ଏବଂ ପ୍ରୟୋଗ କରନ୍ତୁ',
    applyingLabel: 'ପ୍ରୟୋଗ ହେଉଛି…',
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
    extraScenesReportIntro: 'ଆଜି ଆପଣ ସିଡ୍ୟୁଲ୍‌ଠାରୁ ଆଗରୁ କୌଣସି ଅତିରିକ୍ତ ସିନ୍ ସୁଟ୍ କରିଛନ୍ତି କି?',
    extraScenesReportPlaceholder: 'ଉଦାହରଣ: "ସେହି ଲୋକେସନ୍‌ରେ ଥିବାବେଳେ ଏପିସୋଡ୍ ୪ ର ସିନ୍ ୧୨ ଏବଂ ୧୩ ମଧ୍ୟ ସୁଟ୍ କଲୁ।"',
    extraScenesFoundHeading: 'ଅତିରିକ୍ତ ସିନ୍ ମିଳିଲା — ନିଶ୍ଚିତ କରିବା ପୂର୍ବରୁ ସମୀକ୍ଷା କରନ୍ତୁ:',
    prepareNextDaysButton: 'ପରବର୍ତ୍ତୀ ଦିନଗୁଡ଼ିକର ସିଡ୍ୟୁଲ୍ ପ୍ରସ୍ତୁତ କରନ୍ତୁ',
    preparingNextDaysLabel: 'ପ୍ରସ୍ତୁତ ହେଉଛି…',
    prepareNextDaysFeedback: 'ସାମ୍ପ୍ରତିକ ରେକର୍ଡ ହୋଇଥିବା ଦିନ ସମାପ୍ତ ହୋଇଥିବାରୁ ବାକି ଥିବା ସିନ୍‌ଗୁଡ଼ିକୁ ବାକି ଶୁଟିଂ ଦିନଗୁଡ଼ିକରେ ପୁନଃ ବଣ୍ଟନ କରନ୍ତୁ — ପୂର୍ବରୁ ସମାପ୍ତ ଦିନଗୁଡ଼ିକୁ ଅପରିବର୍ତ୍ତିତ ରଖନ୍ତୁ।',
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
      skeptic: 'ସନ୍ଦେହୀ',
      community: 'ଗାଁ ସମାଜ',
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
  if (format?.type === 'vertical') {
    return t.formatVertical(format.episodeCount, format.episodeMinutes)
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
  mic: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  users: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 20c0-3 2.7-5.5 6-5.5s6 2.5 6 5.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 14.8c2.9.3 5 2.6 5 5.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  calendar: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 5h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 10h18M8 3v4M16 3v4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  camera: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="14" r="3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  document: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 3v4h4M8 12h8M8 16h8M8 20h4" strokeLinecap="round" strokeLinejoin="round" />
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

// Groups one shoot day's scenes by episode, then by location within that
// episode — so "Episode 2: 3 scenes in the Living Room, 4 in the Bedroom"
// reads as a single glance instead of a flat list the AD has to scan scene
// by scene. Preserves the schedule's own shoot order at both levels (first
// appearance order), rather than alphabetizing — that order is deliberate
// (linear-by-location, continuity-bundled), not something to re-sort.
function groupSceneRefsForDisplay(sceneRefs, sceneList, language) {
  const episodeGroups = []
  const episodeIndexToGroup = new Map()

  sceneRefs.forEach((ref, index) => {
    const scene = lookupScene(sceneList, ref)
    if (!scene) return
    const episodeKey = typeof ref.episodeIndex === 'number' ? ref.episodeIndex : null

    let episodeGroup = episodeIndexToGroup.get(episodeKey)
    if (!episodeGroup) {
      episodeGroup = { episodeIndex: episodeKey, locationGroups: [], locationKeyToGroup: new Map() }
      episodeIndexToGroup.set(episodeKey, episodeGroup)
      episodeGroups.push(episodeGroup)
    }

    const locationLabel = scene.location?.[language] || scene.location?.en || ''
    let locationGroup = episodeGroup.locationKeyToGroup.get(locationLabel)
    if (!locationGroup) {
      locationGroup = { location: locationLabel, items: [] }
      episodeGroup.locationKeyToGroup.set(locationLabel, locationGroup)
      episodeGroup.locationGroups.push(locationGroup)
    }
    locationGroup.items.push({ ref, index, scene })
  })

  return episodeGroups
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

// Stored dates stay ISO (yyyy-mm-dd) — that's what <input type="date"> and
// the backend's own date arithmetic need — this only reformats one for
// DISPLAY, to the day-month-year order this production actually uses.
function formatDisplayDate(isoDate) {
  if (!isoDate) return isoDate
  const [y, m, d] = isoDate.split('-')
  if (!y || !m || !d) return isoDate
  return `${d}-${m}-${y}`
}

// A long series/film title needs to fit the sidebar's fixed width without
// being cut off or shrunk illegibly — splitting off a trailing "Season 2" /
// "Part 1" / "S2" style suffix onto its own smaller line (like the
// reference UI's title treatment) reads far better than one long truncated
// line. Titles without that pattern are left as a single line.
function splitProjectTitleForSidebar(title) {
  const match = /^(.*?)[\s:—-]+((?:season|part|series|s)\.?\s*\d+.*)$/i.exec(title || '')
  if (!match) return { main: title, sub: '' }
  return { main: match[1].trim(), sub: match[2].trim() }
}

// Every client-downloaded file gets the same "when was this generated"
// stamp the server's own exports use, so a saved project file is dated too.
// The interval button only appears once the film has run at least this
// long (the user's call: an interval belongs roughly 50 minutes in, never
// on Beat 1). Measured with the Beat Sheet's own fixed times, added up to
// the end of each beat.
const AI_MOVIE_EARLIEST_INTERVAL_MINUTES = 50

function aiMovieMinutesAtEndOfBeat(beats, beatIndex) {
  return beats.slice(0, beatIndex + 1).reduce((sum, beat) => sum + (Number(beat?.runtimeMinutes) || 0), 0)
}

// A Beat Sheet written before beats had times can't be measured, so there
// the button stays on every beat, as before.
function aiMovieIntervalAllowedAfterBeat(beats, beatIndex) {
  if (beatIndex >= beats.length - 1) return false
  if (!beats.some((beat) => Number(beat?.runtimeMinutes) > 0)) return true
  return aiMovieMinutesAtEndOfBeat(beats, beatIndex) >= AI_MOVIE_EARLIEST_INTERVAL_MINUTES
}

// AI Movie screen times are shown in seconds (the user's call: "12 sec",
// never "0.2 min"); anything a minute or longer reads as minutes and
// seconds ("1 min 6 sec"), so a 3-minute song or beat stays readable.
function aiMovieDurationText(minutes, secUnit, minUnit) {
  const totalSeconds = Math.round((Number(minutes) || 0) * 60)
  if (totalSeconds < 60) return `${totalSeconds} ${secUnit}`
  const wholeMinutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds ? `${wholeMinutes} ${minUnit} ${seconds} ${secUnit}` : `${wholeMinutes} ${minUnit}`
}

function formatExportTimestamp(date = new Date()) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const day = date.getDate()
  const month = months[date.getMonth()]
  const year = date.getFullYear()
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const hours12 = date.getHours() % 12 || 12
  const ampm = date.getHours() >= 12 ? 'PM' : 'AM'
  return `${day}-${month}-${year}_${hours12}.${minutes}${ampm}`
}

// Display groups for the artist casting list. Speaking characters split
// into Lead/Sidekick/Extra by narrative importance (castTier); the two
// non-speaking castCategory values (present-but-silent, and off-screen
// voice-only) collapse into ONE "non_speaking" group, since neither needs
// individual casting. Unclassified (not yet run) floats to the top so
// it's obvious there's still something to classify.
const CAST_TIER_GROUP_ORDER = { unclassified: -1, lead: 0, sidekick: 1, extra: 2, non_speaking: 3 }

// A sentinel crew "characterName" — not a real character label — so ONE
// crew member can stand in for every Extra/Junior character at once,
// instead of casting each one individually.
const JUNIOR_ARTIST_COORDINATOR_KEY = '__junior_artist_coordinator__'

function castTierGroup(item) {
  if (!item.castCategory) return 'unclassified'
  if (item.castCategory !== 'speaking') return 'non_speaking'
  return item.castTier || 'extra'
}

function castTierGroupLabel(group, t) {
  if (group === 'lead') return t.castTierLeadLabel
  if (group === 'sidekick') return t.castTierSidekickLabel
  if (group === 'extra') return t.castTierExtraLabel
  if (group === 'non_speaking') return t.castTierNonSpeakingLabel
  return t.castCategoryUnclassifiedLabel
}

// null for a film/short with no episodes, or an item episode-tagging
// hasn't reached yet — nothing renders in either case.
function formatEpisodeNumbers(item, t) {
  if (!item.episodeNumbers || item.episodeNumbers.length === 0) return null
  return `${t.episodeNumbersPrefix} ${item.episodeNumbers.join(', ')}`
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

// Scenes written before dialogue language became a per-scene choice stored
// text/parenthetical as {en, or, hi} bilingual objects, not plain strings —
// rendering one of those objects directly as a JSX child crashes React
// ("Objects are not valid as a React child"), taking down the whole app.
// This normalizes either shape so older, already-written scenes keep
// displaying (in the app's current language toggle) alongside new ones.
function screenplayText(value, language) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') return value[language] ?? value.en ?? value.or ?? value.hi ?? ''
  return ''
}

function ScreenplayElements({ elements, language }) {
  return (
    <div className="screenplay-elements">
      {elements.map((element, index) => {
        const text = screenplayText(element.text, language)
        const parenthetical = screenplayText(element.parenthetical, language)
        if (element.type === 'dialogue') {
          const modifier = element.characterModifier && element.characterModifier !== 'none' ? ` (${element.characterModifier})` : ''
          return (
            <div key={index} className="screenplay-dialogue">
              <p className="screenplay-character">{element.character}{modifier}</p>
              {parenthetical && (
                <p className="screenplay-parenthetical">({parenthetical})</p>
              )}
              <p className="screenplay-dialogue-text">{text}</p>
            </div>
          )
        }
        if (element.type === 'transition') {
          return (
            <p key={index} className="screenplay-transition">
              {text}
            </p>
          )
        }
        if (element.type === 'flashback') {
          return (
            <p key={index} className="screenplay-flashback">
              <strong>FLASH - {element.character}'S POV:</strong> {text}
            </p>
          )
        }
        return (
          <p key={index} className="screenplay-action">
            {text}
          </p>
        )
      })}
    </div>
  )
}

function ScreenplayBlock({ episodeIndex, sceneIndex, t, language, screenplay, toolsOnly = false }) {
  if (!screenplay) return null

  const key = screenplayKey(episodeIndex, sceneIndex)
  const draft = screenplay.scenesByKey[key]
  const isGenerating = screenplay.generatingKey === key
  const isSubmittingFeedback = screenplay.submittingFeedbackKey === key
  const showFeedbackForm = screenplay.feedbackFormKey === key

  if (!draft) {
    const dialogueLanguage = screenplay.dialogueLanguageByKey[key] ?? 'en'
    return (
      <div className="write-scene-controls">
        <select
          className="dialogue-language-select"
          value={dialogueLanguage}
          onChange={(e) => screenplay.onDialogueLanguageChange(key, e.target.value)}
          disabled={isGenerating}
        >
          <option value="en">{t.dialogueLanguageEnglish}</option>
          <option value="or">{t.dialogueLanguageOdia}</option>
          <option value="hi">{t.dialogueLanguageHindi}</option>
        </select>
        <button
          className="choose-button write-scene-button"
          onClick={() => screenplay.onWriteScene(episodeIndex, sceneIndex, dialogueLanguage)}
          disabled={isGenerating}
        >
          {isGenerating ? t.generatingScreenplayScene : t.writeSceneButton}
        </button>
        <AnalyzingProgressBar active={isGenerating} label={t.generatingScreenplayScene} estimatedSeconds={25} />
      </div>
    )
  }

  return (
    <div className={toolsOnly ? 'screenplay-block screenplay-block-tools' : 'screenplay-block'}>
      {!toolsOnly && draft.charactersPresent?.length > 0 && (
        <p className="screenplay-characters-line">{t.screenplayCharactersLabel}: {draft.charactersPresent.join(', ')}</p>
      )}
      {!toolsOnly && <ScreenplayElements elements={draft.elements} language={language} />}

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
          <MicTextarea
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

const AUTO_PIPELINE_RUN_ID_STORAGE_KEY = 'filmmaking-app:floatingAgentRunId'
const FLOATING_AGENT_POSITION_STORAGE_KEY = 'filmmaking-app:floatingAgentPosition'

// Different cutout poses for different moments — waving/pointing while
// idle, thinking-with-a-clipboard while a run is actually working, and
// celebrating once it's done — cycled on a timer per set (not a CSS sprite
// grid, since the source frames aren't uniform width). Genuinely swapping
// both POSE and frame is what reads as "alive and reacting", not just a
// single static image gently bobbing.
const FLOATING_AGENT_FRAME_SETS = {
  idle: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `/agent/idle/${n}.png`),
  working: [1, 2, 3, 4].map((n) => `/agent/working/${n}.png`),
  done: [1, 2, 3, 4].map((n) => `/agent/done/${n}.png`),
  failed: [1, 2, 3, 4].map((n) => `/agent/working/${n}.png`),
}

function floatingAgentFramesFor(runStatus) {
  return FLOATING_AGENT_FRAME_SETS[runStatus] ?? FLOATING_AGENT_FRAME_SETS.idle
}

// Coarse but real progress: each stage the backend reports maps to a step
// in this fixed sequence, so the panel can show an actual filling progress
// bar (not just a spinner) even though we don't have finer-grained percent
// data from the server.
const AUTO_PIPELINE_STAGE_ORDER = [
  'starting', 'story-brain', 'story-bible', 'storylines', 'pitch-deck', 'character-sheet', 'three-act', 'bit-sheet', 'scene-list',
  'screenplay', 'sequence-review', 'quality-pass', 'language-check', 'done',
]
// The stages the pen window's timeline lists (everything but start/done).
const AUTO_PIPELINE_TIMELINE_STAGES = AUTO_PIPELINE_STAGE_ORDER.slice(1, -1)
// The Story Brain designs films and web series first (STORY_BRAIN_DESIGN.md);
// vertical micro-dramas skip it.
const STORY_BRAIN_STAGES = ['story-brain', 'story-bible']
function runUsesStoryBrain(format) {
  return format?.type === 'film' || format?.type === 'series'
}

// The one-page summary of a Story Bible the user approves (or gives a note on).
function StoryBibleSummary({ bible, t }) {
  const p = bible.promise ?? {}
  const units = bible.blueprint ?? []
  const first = units[0]
  const review = bible.review
  const criticNames = { storyDoctor: t.bibleCriticDoctor, audienceCritic: t.bibleCriticAudience, cultureExpert: t.bibleCriticCulture }
  const openProblems = Object.entries(review?.reports ?? {}).flatMap(([key, report]) =>
    (report.problems ?? []).filter((x) => x.severity !== 'minor').map((x) => ({ critic: criticNames[key] ?? key, ...x }))
  )
  return (
    <div className="story-bible-summary">
      <h3 className="story-bible-title">{p.title}</h3>
      <p className="story-bible-logline">{p.logline}</p>
      {review && (
        <div className={`story-bible-verdict ${review.passed ? 'is-passed' : 'is-open'}`}>
          <strong>{review.passed ? t.bibleCriticsPassed : t.bibleCriticsNeedInput}</strong>
          <div className="story-bible-scores">
            {Object.entries(review.scores ?? {}).map(([key, score]) => (
              <span key={key} className={`floating-agent-score ${autoPipelineScoreClass(score)}`}>{criticNames[key] ?? key} {score}/10</span>
            ))}
          </div>
        </div>
      )}
      <dl className="story-bible-points">
        <dt>{t.bibleQuestionLabel}</dt><dd>{p.centralQuestion}</dd>
        {first && (<><dt>{t.bibleOpeningLabel}</dt><dd>{first.coldOpen}<br /><em>{first.endingHook}</em></dd></>)}
        {bible.climax && (<><dt>{t.bibleClimaxLabel}</dt><dd>{bible.climax.reversal} {bible.climax.heroChoice}</dd><dt>{t.bibleFinalImageLabel}</dt><dd>{bible.climax.finalImage}</dd></>)}
      </dl>
      <p className="floating-agent-section-title">{bible.units?.kind === 'episode' ? t.bibleEpisodeHooksLabel : t.bibleSequenceHooksLabel}</p>
      <ol className="story-bible-hooks">
        {units.map((u) => (
          <li key={u.number}><strong>{u.title}</strong> — {u.endingHook}</li>
        ))}
      </ol>
      {openProblems.length > 0 && (
        <details className="story-bible-problems">
          <summary>{t.bibleOpenProblemsLabel(openProblems.length)}</summary>
          <ul>
            {openProblems.map((x, i) => (
              <li key={i}><strong>{x.critic} — {x.where}:</strong> {x.problem}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

// One run-log note, split into the parts the pen window shows: the judge's
// score (as a coloured chip), the version number, a small icon for the
// special notes, and the rest of the text.
function parseAutoPipelineNote(note) {
  const text = note?.note ?? ''
  const version = text.match(/^Version (\d+) — /)
  const rest = version ? text.slice(version[0].length) : text
  const judged = rest.match(/^Judge score: (\d+)\/10 — /)
  const body = judged ? rest.slice(judged[0].length) : rest
  // Icons only mark the special notes, never a judge's verdict.
  const icon = judged ? null
    : /^Picked option/.test(text) ? '★'
    : /^Kept version/.test(text) ? '✓'
    : /^Stopped early/.test(text) ? '■'
    : /fresh version/.test(text) ? '↻'
    : /could not|failed/i.test(text) ? '!'
    : /is reading it/.test(text) ? '✎'
    : null
  return { stage: note?.stage ?? '', version: version ? Number(version[1]) : null, score: judged ? Number(judged[1]) : null, body, icon }
}

function autoPipelineScoreClass(score) {
  return score >= 7 ? 'is-good' : score >= 5 ? 'is-mid' : 'is-low'
}

function autoPipelineProgressPercent(stage) {
  const index = AUTO_PIPELINE_STAGE_ORDER.indexOf(stage)
  if (index < 0) return 5
  return Math.max(5, Math.round((index / (AUTO_PIPELINE_STAGE_ORDER.length - 1)) * 100))
}

// The floating, draggable "auto-pipeline" agent — lets an admin describe a
// concept and get a fully-generated project (through every screenplay scene)
// back as one downloadable PDF, without clicking through each stage
// manually. Position is a per-viewer convenience (localStorage only); the
// run itself lives server-side so a page refresh doesn't lose progress.
function FloatingAgentWidget({ currentUser, t, onRunCompleted, onOpenProject }) {
  const [position, setPosition] = useState(() => {
    try {
      const saved = localStorage.getItem(FLOATING_AGENT_POSITION_STORAGE_KEY)
      if (saved) return JSON.parse(saved)
    } catch {
      // ignore — fall through to default
    }
    return { x: 16, y: 90 }
  })
  const [isOpen, setIsOpen] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const dragOffset = useRef({ x: 0, y: 0 })
  const dragStart = useRef({ x: 0, y: 0 })
  const hasDraggedRef = useRef(false)

  const [concept, setConcept] = useState('')
  const [formatType, setFormatType] = useState('vertical')
  const [episodeCount, setEpisodeCount] = useState(60)
  const [episodeMinutes, setEpisodeMinutes] = useState(1.5)
  const [filmMinutes, setFilmMinutes] = useState(120)
  const [dialogueLanguage, setDialogueLanguage] = useState('or')
  const [downloadFormat, setDownloadFormat] = useState('pdf')
  const [downloadLanguage, setDownloadLanguage] = useState('or')

  const [runId, setRunId] = useState(() => {
    try {
      return localStorage.getItem(AUTO_PIPELINE_RUN_ID_STORAGE_KEY) || null
    } catch {
      return null
    }
  })
  const [status, setStatus] = useState(null)
  const [isStarting, setIsStarting] = useState(false)
  const [isResuming, setIsResuming] = useState(false)
  // Bumped whenever polling needs to be force-restarted for the SAME runId
  // (see handleResume) — the poll effect below stops its own interval once
  // a run reaches 'failed'/'completed' (no point polling a dead run), so
  // resuming that same run id would otherwise leave nothing left to ever
  // notice it's running again.
  const [pollNonce, setPollNonce] = useState(0)
  const [errorMessage, setErrorMessage] = useState(null)
  const [bibleNote, setBibleNote] = useState('')
  const [isSendingBible, setIsSendingBible] = useState(false)
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [frameIndex, setFrameIndex] = useState(0)
  const statusRef = useRef(null)
  const notifiedRef = useRef(false)
  const runStartedAtRef = useRef(null)

  // localStorage's runId is per-BROWSER, so opening the app on a different
  // device (or a different browser) under the same login used to show a
  // blank "start a new one" form even while a run was actively in progress
  // elsewhere. On mount, ask the backend which run this same logged-in user
  // most recently started and adopt it — same account, same progress,
  // whichever device it's opened on.
  useEffect(() => {
    if (!currentUser) return undefined
    let cancelled = false
    async function syncActiveRun() {
      try {
        const response = await fetch(`${BACKEND_URL}/api/auto-pipeline/runs`)
        if (!response.ok || cancelled) return
        const runs = await response.json()
        if (!Array.isArray(runs) || runs.length === 0) return
        const latestId = String(runs[0].id)
        setRunId((current) => (current === latestId ? current : latestId))
        try {
          localStorage.setItem(AUTO_PIPELINE_RUN_ID_STORAGE_KEY, latestId)
        } catch {
          // per-viewer convenience only
        }
      } catch {
        // network hiccup — keep whatever this device already had
      }
    }
    syncActiveRun()
    return () => {
      cancelled = true
    }
  }, [currentUser?.username])

  const poseState =
    status?.status === 'running' ? 'working'
      : status?.status === 'completed' || status?.status === 'awaiting_approval' || status?.status === 'approved' ? 'done'
      : status?.status === 'failed' ? 'failed' : 'idle'
  const currentFrames = floatingAgentFramesFor(poseState)

  // Cycles the character frames continuously — faster while a run is
  // actively working, slower (a lazy idle sway) otherwise, so the button
  // always visibly reads as "alive", never a frozen picture. Resets to
  // frame 0 whenever the pose set itself changes, so it doesn't start
  // mid-way through a different pose's frame count.
  useEffect(() => {
    setFrameIndex(0)
  }, [poseState])

  useEffect(() => {
    const speed = poseState === 'working' ? 260 : poseState === 'done' ? 350 : 900
    const frameCount = currentFrames.length
    const interval = setInterval(() => setFrameIndex((i) => (i + 1) % frameCount), speed)
    return () => clearInterval(interval)
  }, [poseState])

  // A visible, always-moving elapsed-time counter — independent of the
  // 4s status poll — so the panel never looks frozen even during a long
  // single Gemini call between polls (a judge-loop round can run a minute
  // or more with no progressStage change at all).
  useEffect(() => {
    if (status?.status !== 'running') return undefined
    const interval = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [status?.status])

  useEffect(() => {
    if (!runId) return undefined
    let cancelled = false

    async function poll() {
      try {
        const response = await fetch(`${BACKEND_URL}/api/auto-pipeline/${runId}/status`)
        const data = await response.json()
        if (cancelled) return
        if (!response.ok) {
          setErrorMessage(data.error || t.genericError)
          return
        }
        setStatus(data)
        statusRef.current = data.status
        if (!runStartedAtRef.current && data.createdAt) {
          runStartedAtRef.current = new Date(data.createdAt).getTime()
        }
        if (data.status === 'completed' && !notifiedRef.current) {
          notifiedRef.current = true
          onRunCompleted?.(data)
        }
      } catch {
        if (!cancelled) setErrorMessage(t.genericError)
      }
    }

    poll()
    const interval = setInterval(() => {
      if (statusRef.current === 'completed' || statusRef.current === 'failed' || statusRef.current === 'approved') {
        clearInterval(interval)
        return
      }
      poll()
    }, 4000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [runId, pollNonce, t.genericError, onRunCompleted])

  function handlePointerDown(e) {
    setIsDragging(true)
    hasDraggedRef.current = false
    dragStart.current = { x: e.clientX, y: e.clientY }
    dragOffset.current = { x: e.clientX - position.x, y: e.clientY - position.y }
  }

  useEffect(() => {
    if (!isDragging) return undefined

    function handleMove(e) {
      if (Math.abs(e.clientX - dragStart.current.x) > 5 || Math.abs(e.clientY - dragStart.current.y) > 5) {
        hasDraggedRef.current = true
      }
      setPosition({ x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y })
    }
    function handleUp() {
      setIsDragging(false)
      setPosition((current) => {
        try {
          localStorage.setItem(FLOATING_AGENT_POSITION_STORAGE_KEY, JSON.stringify(current))
        } catch {
          // per-viewer convenience only — fine if it can't persist
        }
        return current
      })
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
  }, [isDragging])

  function handleButtonClick() {
    if (hasDraggedRef.current) return
    setIsOpen((v) => !v)
  }

  async function handleStart() {
    if (!concept.trim()) return
    setIsStarting(true)
    setErrorMessage(null)
    try {
      const format =
        formatType === 'film'
          ? { type: 'film', runtimeMinutes: Number(filmMinutes) || 120 }
          : { type: formatType, episodeCount: Number(episodeCount), episodeMinutes: Number(episodeMinutes) }

      const response = await fetch(`${BACKEND_URL}/api/auto-pipeline/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ concept, format, dialogueLanguage }),
      })
      const data = await response.json()
      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsStarting(false)
        return
      }
      notifiedRef.current = false
      runStartedAtRef.current = Date.now()
      setStatus(null)
      setRunId(String(data.runId))
      try {
        localStorage.setItem(AUTO_PIPELINE_RUN_ID_STORAGE_KEY, String(data.runId))
      } catch {
        // per-viewer convenience only
      }
    } catch {
      setErrorMessage(t.genericError)
    }
    setIsStarting(false)
  }


  async function handleResume() {
    if (!runId) return
    setIsResuming(true)
    setErrorMessage(null)
    try {
      const response = await fetch(`${BACKEND_URL}/api/auto-pipeline/${runId}/resume`, { method: 'POST' })
      const data = await response.json()
      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsResuming(false)
        return
      }
      notifiedRef.current = false
      statusRef.current = null
      setStatus(null)
      setPollNonce((n) => n + 1)
    } catch {
      setErrorMessage(t.genericError)
    }
    setIsResuming(false)
  }

  // Approve the Story Bible, or send a note for the Brain to revise it.
  async function handleBibleAction(action) {
    if (!runId) return
    setIsSendingBible(true)
    setErrorMessage(null)
    try {
      const response = await fetch(`${BACKEND_URL}/api/auto-pipeline/${runId}/${action === 'approve' ? 'bible-approve' : 'bible-note'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'note' ? { note: bibleNote } : {}),
      })
      const data = await response.json()
      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
      } else {
        if (action === 'note') setBibleNote('')
        statusRef.current = null
        setPollNonce((n) => n + 1)
      }
    } catch {
      setErrorMessage(t.genericError)
    }
    setIsSendingBible(false)
  }

  function handleStartNew() {
    setRunId(null)
    setStatus(null)
    setErrorMessage(null)
    setConcept('')
    runStartedAtRef.current = null
    try {
      localStorage.removeItem(AUTO_PIPELINE_RUN_ID_STORAGE_KEY)
    } catch {
      // per-viewer convenience only
    }
  }

  if (currentUser?.role !== 'admin') return null

  return (
    <>
      <button
        type="button"
        className={`floating-agent-button floating-agent-pose-${poseState}`}
        style={{ left: position.x, top: position.y }}
        onPointerDown={handlePointerDown}
        onClick={handleButtonClick}
        title={t.floatingAgentTitle}
      >
        <img src={currentFrames[frameIndex] ?? currentFrames[0]} alt="" className="floating-agent-image" draggable="false" />
      </button>

      {isOpen && (() => {
        // Opens below the button when it's in the top half of the screen,
        // above it otherwise, and never runs off the screen edges.
        const width = Math.min(400, window.innerWidth - 32)
        const left = Math.min(Math.max(16, position.x), window.innerWidth - width - 16)
        const below = position.y < window.innerHeight / 2
        const panelStyle = below
          ? { left, width, top: position.y + 84, maxHeight: Math.max(260, window.innerHeight - position.y - 100) }
          : { left, width, bottom: window.innerHeight - position.y + 12, maxHeight: Math.max(260, position.y - 28) }
        const notes = (status?.reviewNotes ?? []).map(parseAutoPipelineNote)
        const bestScoreFor = (stage) => {
          const scores = notes.filter((n) => n.stage === stage && n.score !== null).map((n) => n.score)
          return scores.length > 0 ? Math.max(...scores) : null
        }
        const currentIndex = status?.status === 'approved'
          ? AUTO_PIPELINE_STAGE_ORDER.indexOf('story-bible') + 1
          : AUTO_PIPELINE_STAGE_ORDER.indexOf(status?.progressStage)
        const timelineStages = runUsesStoryBrain(status?.format)
          ? AUTO_PIPELINE_TIMELINE_STAGES
          : AUTO_PIPELINE_TIMELINE_STAGES.filter((stage) => !STORY_BRAIN_STAGES.includes(stage))
        const stageState = (stage) => {
          if (status?.status === 'completed') return 'done'
          if (status?.status === 'awaiting_approval' && stage === 'story-bible') return 'current'
          const index = AUTO_PIPELINE_STAGE_ORDER.indexOf(stage)
          if (index < currentIndex) return 'done'
          if (index === currentIndex) return status?.status === 'failed' ? 'failed' : 'current'
          return 'upcoming'
        }
        const elapsedSeconds = status?.status === 'running'
          ? (runStartedAtRef.current ? Math.max(0, Math.floor((nowTick - runStartedAtRef.current) / 1000)) : null)
          : status?.createdAt && status?.updatedAt
            ? Math.max(0, Math.round((new Date(status.updatedAt) - new Date(status.createdAt)) / 1000))
            : null
        const statusLabel = status?.status === 'running' ? t.floatingAgentStatusWorking
          : status?.status === 'completed' ? t.floatingAgentStageNames.done
          : status?.status === 'failed' ? t.floatingAgentStatusStopped
          : status?.status === 'awaiting_approval' ? t.floatingAgentStatusAwaiting
          : status?.status === 'approved' ? t.floatingAgentStatusApproved
          : null

        return (
          <div className={`floating-agent-panel${status?.status ? ` is-${status.status}` : ''}`} style={panelStyle}>
            <div className="floating-agent-header">
              <img src={currentFrames[frameIndex] ?? currentFrames[0]} alt="" className={`floating-agent-header-character floating-agent-pose-${poseState}`} draggable="false" />
              <div className="floating-agent-header-text">
                <strong>{t.floatingAgentTitle}</strong>
                {runId && status?.conceptText && <span className="floating-agent-concept">{status.conceptText}</span>}
              </div>
              {statusLabel && <span className={`floating-agent-status-pill is-${status.status}`}>{statusLabel}</span>}
              <button type="button" className="floating-agent-close" onClick={() => setIsOpen(false)} aria-label="Close">×</button>
            </div>

            {!runId && (
              <div className="floating-agent-form">
                <MicTextarea
                  placeholder={t.floatingAgentConceptPlaceholder}
                  value={concept}
                  onChange={(e) => setConcept(e.target.value)}
                />
                <select value={formatType} onChange={(e) => setFormatType(e.target.value)}>
                  <option value="vertical">{t.verticalDramaOption}</option>
                  <option value="series">{t.seriesOption}</option>
                  <option value="film">{t.filmOption}</option>
                </select>
                {formatType === 'film' ? (
                  <label className="floating-agent-field">
                    <span>{t.floatingAgentFilmMinutesLabel}</span>
                    <input type="number" min="1" value={filmMinutes} onChange={(e) => setFilmMinutes(e.target.value)} />
                  </label>
                ) : (
                  <div className="floating-agent-row">
                    <label className="floating-agent-field">
                      <span>{t.episodeCountLabel}</span>
                      <input type="number" min="1" value={episodeCount} onChange={(e) => setEpisodeCount(e.target.value)} />
                    </label>
                    <label className="floating-agent-field">
                      <span>{t.episodeMinutesLabel}</span>
                      <input type="number" min="0.1" step="0.1" value={episodeMinutes} onChange={(e) => setEpisodeMinutes(e.target.value)} />
                    </label>
                  </div>
                )}
                <select value={dialogueLanguage} onChange={(e) => setDialogueLanguage(e.target.value)}>
                  <option value="en">{t.dialogueLanguageEnglish}</option>
                  <option value="or">{t.dialogueLanguageOdia}</option>
                  <option value="hi">{t.dialogueLanguageHindi}</option>
                </select>
                {errorMessage && <p className="feedback-note">{errorMessage}</p>}
                <button type="button" className="choose-button" onClick={handleStart} disabled={isStarting || !concept.trim()}>
                  {isStarting ? t.floatingAgentStarting : t.floatingAgentStartButton}
                </button>
              </div>
            )}

            {runId && status && (
              <>
                {status.status === 'running' && (
                  <div className="floating-agent-now">
                    <div className="floating-agent-progress-bar">
                      <div className="floating-agent-progress-fill" style={{ width: `${autoPipelineProgressPercent(status.progressStage)}%` }} />
                    </div>
                    <p className="floating-agent-stage-line">
                      <span className="floating-agent-spinner" aria-hidden="true" />
                      <span>{t.floatingAgentStageNames[status.progressStage] ?? status.progressStage}</span>
                      {elapsedSeconds !== null && <span className="floating-agent-elapsed">{t.aiMovieShortDuration(elapsedSeconds / 60)}</span>}
                    </p>
                  </div>
                )}

                {(status.status === 'awaiting_approval' || status.status === 'approved') && status.storyBible && (
                  <div className="floating-agent-done story-bible-block">
                    <p className="floating-agent-done-title">{status.status === 'approved' ? t.bibleApprovedLabel : t.bibleReadyLabel}</p>
                    <StoryBibleSummary bible={status.storyBible} t={t} />
                    <a className="cancel-button floating-agent-download" href={`${BACKEND_URL}/api/auto-pipeline/${runId}/story-bible`} target="_blank" rel="noreferrer">
                      {t.bibleOpenFullButton}
                    </a>
                    {status.status === 'awaiting_approval' && (
                      <>
                        <button type="button" className="choose-button" onClick={() => handleBibleAction('approve')} disabled={isSendingBible}>
                          {t.bibleApproveButton}
                        </button>
                        <MicTextarea placeholder={t.bibleNotePlaceholder} value={bibleNote} onChange={(e) => setBibleNote(e.target.value)} />
                        <button type="button" className="cancel-button" onClick={() => handleBibleAction('note')} disabled={isSendingBible || !bibleNote.trim()}>
                          {isSendingBible ? t.bibleSending : t.bibleSendNoteButton}
                        </button>
                      </>
                    )}
                    {errorMessage && <p className="feedback-note">{errorMessage}</p>}
                    <button type="button" className="cancel-button" onClick={handleStartNew}>
                      {t.floatingAgentNewRunButton}
                    </button>
                  </div>
                )}

                {status.status === 'completed' && (
                  <div className="floating-agent-done">
                    <p className="floating-agent-done-title">
                      {t.floatingAgentDoneLabel}
                      {elapsedSeconds !== null && <span className="floating-agent-elapsed"> · {t.aiMovieShortDuration(elapsedSeconds / 60)}</span>}
                    </p>
                    {status.conceptId && onOpenProject && (
                      <button type="button" className="choose-button" onClick={() => { onOpenProject(status.conceptId); setIsOpen(false) }}>
                        {t.floatingAgentOpenProjectButton}
                      </button>
                    )}
                    <div className="floating-agent-row">
                      <select value={downloadFormat} onChange={(e) => setDownloadFormat(e.target.value)}>
                        <option value="pdf">{t.floatingAgentFormatPdf}</option>
                        <option value="docx">{t.floatingAgentFormatWord}</option>
                      </select>
                      <select value={downloadLanguage} onChange={(e) => setDownloadLanguage(e.target.value)}>
                        <option value="or">{t.dialogueLanguageOdia}</option>
                        <option value="hi">{t.dialogueLanguageHindi}</option>
                        <option value="en">{t.dialogueLanguageEnglish}</option>
                      </select>
                    </div>
                    <a
                      className="cancel-button floating-agent-download"
                      href={`${BACKEND_URL}/api/auto-pipeline/${runId}/screenplay-${downloadFormat}?lang=${downloadLanguage}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {downloadLanguage === 'or' ? t.floatingAgentDownloadButton : t.floatingAgentTranslateDownloadButton}
                    </a>
                    <button type="button" className="cancel-button" onClick={handleStartNew}>
                      {t.floatingAgentNewRunButton}
                    </button>
                  </div>
                )}

                {status.status === 'failed' && (
                  <div className="floating-agent-done">
                    <p className="feedback-note">{status.error}</p>
                    {status.conceptId && (
                      <button type="button" className="choose-button" onClick={handleResume} disabled={isResuming}>
                        {isResuming ? t.floatingAgentResuming : t.floatingAgentResumeButton}
                      </button>
                    )}
                    <button type="button" className="cancel-button" onClick={handleStartNew}>
                      {t.floatingAgentNewRunButton}
                    </button>
                  </div>
                )}
                <div className="floating-agent-section">
                  <p className="floating-agent-section-title">{t.floatingAgentTimelineTitle}</p>
                  <ol className="floating-agent-timeline">
                    {timelineStages.map((stage) => {
                      const state = stageState(stage)
                      // The script editor scores each sequence separately, so
                      // one "best" number would hide the weaker sequences.
                      const best = stage === 'sequence-review' ? null : bestScoreFor(stage)
                      return (
                        <li key={stage} className={`floating-agent-timeline-item is-${state}`}>
                          <span className="floating-agent-timeline-dot" aria-hidden="true">{state === 'done' ? '✓' : state === 'failed' ? '!' : ''}</span>
                          <span className="floating-agent-timeline-name">{t.floatingAgentStageNames[stage] ?? stage}</span>
                          {best !== null && <span className={`floating-agent-score ${autoPipelineScoreClass(best)}`}>{best}/10</span>}
                        </li>
                      )
                    })}
                  </ol>
                </div>

                {notes.length > 0 && (
                  <div className="floating-agent-section">
                    <p className="floating-agent-section-title">{t.floatingAgentNotesTitle}</p>
                    <ul className="floating-agent-feed">
                      {notes.slice().reverse().map((n, i) => (
                        <li key={notes.length - i} className="floating-agent-feed-item">
                          <div className="floating-agent-feed-meta">
                            <span className="floating-agent-feed-stage">{t.floatingAgentStageNames[n.stage] ?? n.stage}</span>
                            {n.version !== null && <span className="floating-agent-feed-version">v{n.version}</span>}
                            {n.score !== null && <span className={`floating-agent-score ${autoPipelineScoreClass(n.score)}`}>{n.score}/10</span>}
                            {n.icon && <span className="floating-agent-feed-icon" aria-hidden="true">{n.icon}</span>}
                          </div>
                          <p className="floating-agent-feed-text">{n.body}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

              </>
            )}

            {runId && !status && !errorMessage && <p className="sidebar-section-note">{t.loadingLabel}</p>}
            {runId && errorMessage && <p className="feedback-note">{errorMessage}</p>}
          </div>
        )
      })()}
    </>
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

// The character-name line above a dialogue block, exactly as a real
// screenplay prints it: the name, then (V.O.)/(O.S.) if set, then (CONT'D)
// when the same character is picking up again after an action line
// interrupted their speech -- standard format, worked out here rather than
// asked of the AI.
function aiMovieDialogueCharacterCue(blocks, blockIndex) {
  const block = blocks[blockIndex]
  let cue = block.character ?? ''
  if (block.extension) cue += ` (${block.extension})`
  let sawActionBetween = false
  for (let i = blockIndex - 1; i >= 0; i--) {
    if (blocks[i].type !== 'dialogue') {
      sawActionBetween = true
      continue
    }
    if (blocks[i].character === block.character && sawActionBetween) cue += " (CONT'D)"
    break
  }
  return cue
}

// Finds the scene a Script Doctor note is still about, by the heading it
// remembered at review time -- preferring its original position, then any
// scene with that heading. -1 means the scene has changed since the review,
// so the fix must not be applied to whatever now sits in that position.
function aiMovieDoctorNoteSceneIndex(scenes, note) {
  const key = (heading) => (heading ?? '').trim().toUpperCase()
  if (!Array.isArray(scenes) || !note?.sceneHeading) return -1
  const original = note.sceneNumber - 1
  if (key(scenes[original]?.sceneHeading?.en) === key(note.sceneHeading)) return original
  return scenes.findIndex((scene) => key(scene.sceneHeading?.en) === key(note.sceneHeading))
}

// Same rule as the backend's isAiMovieSongBeat: the Beat Sheet itself
// says "song" in the beat's title or description.
function isAiMovieSongBeat(beatMeta) {
  return /\bsongs?\b/i.test(`${beatMeta?.title?.en ?? ''} ${beatMeta?.description?.en ?? ''}`)
}

// A song fills real screen time but is only a short paragraph on the page,
// so its own length counts toward the beat's total (the target never moves).
function aiMovieSongMinutes(screenplayBeat) {
  const minutes = screenplayBeat?.song?.durationMinutes
  return typeof minutes === 'number' && minutes > 0 ? minutes : 0
}

// `mismatchNote` lets a screen say which tool actually fixes the gap -- the
// AI Movie screen points to Extend (short) or a scene's Request Changes
// (long) rather than the generic "Request Changes" advice, which there
// would regenerate the whole beat and throw its dialogue away.
function RuntimeSummary({ total, target, t, mismatchNote, label }) {
  if (typeof total !== 'number' || !target) return null
  const isMismatch = Math.abs(total - target) / target > 0.25
  const note = typeof mismatchNote === 'function' ? mismatchNote(total < target) : t.runtimeMismatchNote

  return (
    <p className={isMismatch ? 'feedback-note' : 'runtime-summary'}>
      {(label ?? t.totalRuntimeLabel)(total, target)}
      {isMismatch && (
        <>
          <br />
          {note}
        </>
      )}
    </p>
  )
}

// Movie's screenplay, in the same working layout as AI Movie (the user's
// request): scene list | script page | the selected scene's tools, a
// Light/Dark page, typing straight into a written scene with Submit (the
// AI corrects grammar and language -- action in English, dialogue in the
// scene's own language), "Check full script", and a note when the script
// has changed since Production's breakdown was made. Series and vertical
// dramas show one episode's page at a time, with an episode bar.
function movieSlugline(scene) {
  const place = (scene.location?.en ?? scene.location ?? '').toString().toUpperCase()
  return `${scene.intExt ?? 'INT'}. ${place} - ${scene.timeOfDay === 'NIGHT' ? 'NIGHT' : 'DAY'}`
}

// Production's breakdown is built from the written scenes: when a scene
// changed after the breakdown was made, say so at the top of the
// Script Breakdown.
function MovieBreakdownFreshnessNote({ sceneListId, t }) {
  const [stale, setStale] = useState(false)
  useEffect(() => {
    if (!sceneListId) return
    fetch(`${BACKEND_URL}/api/scene-lists/${sceneListId}/breakdown-freshness`)
      .then((response) => response.json())
      .then((data) => setStale(Boolean(data?.stale)))
      .catch(() => {})
  }, [sceneListId])
  return stale ? <p className="feedback-note movie-breakdown-stale-note">{t.movieBreakdownStaleNote}</p> : null
}

function MovieScreenplayWorkspace({
  sceneList, episodes, t, language, screenplay, scriptTheme, onChangeScriptTheme, onSceneSaved, onReloadScenes, onSceneListChanged,
}) {
  const groups = sceneList.episodeScenes
    ? sceneList.episodeScenes.map((episodeScene, index) => ({
        episodeIndex: index,
        title: episodes?.[index]?.title?.[language] ?? episodes?.[index]?.title?.en ?? '',
        scenes: episodeScene.scenes ?? [],
        total: episodeScene.totalEstimatedMinutes,
        target: episodeScene.targetMinutes,
      }))
    : [{ episodeIndex: null, title: '', scenes: sceneList.scenes ?? [], total: sceneList.totalEstimatedMinutes, target: sceneList.targetMinutes }]
  const [groupIndex, setGroupIndex] = useState(0)
  const [turn, setTurn] = useState('open')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [editing, setEditing] = useState(null)
  const [isSubmittingEdit, setIsSubmittingEdit] = useState(false)
  const [editError, setEditError] = useState(null)
  const [editFixes, setEditFixes] = useState(null)
  const [check, setCheck] = useState(null)
  const [checkError, setCheckError] = useState(null)
  const [showReport, setShowReport] = useState(false)
  const [breakdownStale, setBreakdownStale] = useState(false)
  // The "add a scene" form ({ position, intExt, location, timeOfDay, oneLiner, estimatedMinutes }) or null.
  const [sceneForm, setSceneForm] = useState(null)
  const [isChangingScenes, setIsChangingScenes] = useState(false)
  const [sceneChangeError, setSceneChangeError] = useState(null)
  const [scenesMoved, setScenesMoved] = useState(false)

  const group = groups[Math.min(groupIndex, groups.length - 1)] ?? groups[0]
  const scenes = group.scenes
  const sceneIndex = Math.min(selectedIndex, Math.max(scenes.length - 1, 0))
  const scene = scenes[sceneIndex]
  const keyOf = (index) => screenplayKey(group.episodeIndex, index)
  const draftOf = (index) => screenplay?.scenesByKey?.[keyOf(index)]
  const numberOf = (s, index) => (s?.sceneNumber ? cleanSceneNumber(s.sceneNumber) : index + 1)
  const selectedKey = keyOf(sceneIndex)
  const draft = draftOf(sceneIndex)
  const allDrafts = Object.values(screenplay?.scenesByKey ?? {}).filter((d) => Array.isArray(d?.elements) && d.elements.length > 0)
  const isAiWriting =
    Boolean(screenplay?.generatingKey) || Boolean(screenplay?.submittingFeedbackKey) || isSubmittingEdit

  async function refreshBreakdownFreshness() {
    try {
      const response = await fetch(`${BACKEND_URL}/api/scene-lists/${sceneList.id}/breakdown-freshness`)
      const data = await response.json()
      setBreakdownStale(Boolean(data?.stale))
    } catch {
      // Only a hint -- a missed check just shows no note.
    }
  }

  async function pollCheck() {
    try {
      const response = await fetch(`${BACKEND_URL}/api/scene-lists/${sceneList.id}/script-check`)
      const data = await response.json()
      setCheck(data)
      if (data?.status === 'running') {
        setTimeout(pollCheck, 4000)
      } else if (data?.status === 'done') {
        onReloadScenes?.()
        refreshBreakdownFreshness()
      }
    } catch {
      setTimeout(pollCheck, 8000)
    }
  }

  useEffect(() => {
    refreshBreakdownFreshness()
    pollCheck()
    // Only when a different scene list is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneList.id])

  useEffect(() => {
    setSelectedIndex(0)
    setEditing(null)
  }, [groupIndex])

  function selectScene(index, scrollToIt) {
    setSelectedIndex(index)
    if (scrollToIt) document.getElementById(`movie-script-scene-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function startEditing(index) {
    const d = draftOf(index)
    if (!d) return
    setEditing({
      key: keyOf(index),
      draftId: d.id,
      elements: d.elements.map((e) => ({
        type: e.type === 'flashback' ? 'flashback' : e.type,
        character: e.character ?? '',
        characterModifier: e.characterModifier ?? 'none',
        parenthetical: screenplayText(e.parenthetical, language),
        text: screenplayText(e.text, language),
      })),
    })
    setEditError(null)
    setEditFixes(null)
    setSelectedIndex(index)
  }

  function openSceneForm(position) {
    setSceneForm({ position, intExt: 'INT', location: '', timeOfDay: 'DAY', oneLiner: '', estimatedMinutes: 2 })
    setSceneChangeError(null)
  }

  // Adds the new scene to the scene list (later scenes move down by one),
  // then either asks the AI to write it or leaves the user's line as a blank
  // scene to edit by hand.
  async function submitNewScene(writeWithAi) {
    if (!sceneForm || !sceneForm.location.trim() || !sceneForm.oneLiner.trim()) return
    setIsChangingScenes(true)
    setSceneChangeError(null)
    try {
      const dialogueLanguage = draftOf(sceneIndex)?.dialogueLanguage ?? 'or'
      const response = await fetch(`${BACKEND_URL}/api/scene-lists/${sceneList.id}/scenes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...sceneForm, episodeIndex: group.episodeIndex, blank: !writeWithAi, dialogueLanguage }),
      })
      const data = await response.json()
      if (!response.ok) {
        setSceneChangeError(data.error || t.genericError)
        setIsChangingScenes(false)
        return
      }
      setEditing(null)
      setEditFixes(null)
      setSceneForm(null)
      await onSceneListChanged?.(data.sceneList)
      setSelectedIndex(data.sceneIndex)
      setScenesMoved(true)
      setIsChangingScenes(false)
      if (writeWithAi) await screenplay?.onWriteScene?.(group.episodeIndex, data.sceneIndex, dialogueLanguage)
    } catch {
      setSceneChangeError(t.genericError)
      setIsChangingScenes(false)
    }
  }

  async function deleteSelectedScene() {
    if (!window.confirm(t.sceneDeleteConfirm(numberOf(scene, sceneIndex)))) return
    setIsChangingScenes(true)
    setSceneChangeError(null)
    try {
      const response = await fetch(`${BACKEND_URL}/api/scene-lists/${sceneList.id}/scenes`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodeIndex: group.episodeIndex, sceneIndex }),
      })
      const data = await response.json()
      if (!response.ok) {
        setSceneChangeError(data.error || t.genericError)
      } else {
        setEditing(null)
        setEditFixes(null)
        await onSceneListChanged?.(data.sceneList)
        setSelectedIndex(Math.max(0, sceneIndex - 1))
        setScenesMoved(true)
      }
    } catch {
      setSceneChangeError(t.genericError)
    }
    setIsChangingScenes(false)
  }

  const updateElement = (i, patch) => setEditing((prev) => prev && { ...prev, elements: prev.elements.map((e, j) => (j === i ? { ...e, ...patch } : e)) })
  const insertElement = (after, type) =>
    setEditing((prev) => prev && {
      ...prev,
      elements: [...prev.elements.slice(0, after + 1), { type, character: '', characterModifier: 'none', parenthetical: '', text: '' }, ...prev.elements.slice(after + 1)],
    })
  const removeElement = (i) => setEditing((prev) => prev && { ...prev, elements: prev.elements.filter((_, j) => j !== i) })

  async function submitEdit() {
    if (!editing) return
    setIsSubmittingEdit(true)
    setEditError(null)
    try {
      const response = await fetch(`${BACKEND_URL}/api/screenplay/scene/${editing.draftId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ elements: editing.elements }),
      })
      const data = await response.json()
      if (!response.ok) {
        setEditError(data.error || t.genericError)
      } else {
        onSceneSaved?.(editing.key, data.scene)
        setEditFixes({ key: editing.key, fixes: data.fixes ?? [] })
        setEditing(null)
        refreshBreakdownFreshness()
      }
    } catch {
      setEditError(t.genericError)
    }
    setIsSubmittingEdit(false)
  }

  async function startCheck() {
    // Same batching as the server: scenes are checked 4 at a time, one language per batch.
    const perLanguage = {}
    allDrafts.forEach((d) => { const lang = d.dialogueLanguage || 'en'; perLanguage[lang] = (perLanguage[lang] ?? 0) + 1 })
    const calls = Math.max(1, Object.values(perLanguage).reduce((n, count) => n + Math.ceil(count / 4), 0))
    if (!window.confirm(t.movieScriptCheckConfirm(allDrafts.length, calls))) return
    setCheckError(null)
    setShowReport(false)
    try {
      const response = await fetch(`${BACKEND_URL}/api/scene-lists/${sceneList.id}/script-check`, { method: 'POST' })
      const data = await response.json()
      if (!response.ok) {
        setCheckError(data.error || t.genericError)
        return
      }
      pollCheck()
    } catch {
      setCheckError(t.genericError)
    }
  }

  const rowsFor = (text, width) => Math.max(1, (text ?? '').split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / width)), 0))

  function renderElements(elements) {
    return elements.map((element, index) => {
      const text = screenplayText(element.text, language)
      const parenthetical = screenplayText(element.parenthetical, language)
      if (element.type === 'dialogue') {
        const modifier = element.characterModifier && element.characterModifier !== 'none' ? ` (${element.characterModifier})` : ''
        return (
          <div key={index} className="script-dialogue">
            <p className="script-character">{element.character}{modifier}</p>
            {parenthetical && <p className="script-parenthetical">({parenthetical})</p>}
            <p className="script-line">{text}</p>
          </div>
        )
      }
      if (element.type === 'transition') return <p key={index} className="script-transition">{text}</p>
      if (element.type === 'flashback') {
        return (
          <p key={index} className="script-action"><strong>FLASH - {element.character}'S POV:</strong> {text}</p>
        )
      }
      return <p key={index} className="script-action">{text}</p>
    })
  }

  function renderEditableScene(index, s) {
    return (
      <div key={index} id={`movie-script-scene-${index}`} className="script-scene is-selected is-editing">
        <p className="script-slug">
          <span className="script-scene-number script-scene-number-left">{numberOf(s, index)}</span>
          {movieSlugline(s)}
          <span className="script-scene-number script-scene-number-right">{numberOf(s, index)}</span>
        </p>
        {editing.elements.map((element, i) => (
          <div key={i} className={`script-edit-block script-edit-block-${element.type}`}>
            {element.type === 'dialogue' ? (
              <div className="script-dialogue">
                <input className="script-edit-field script-character" value={element.character} onChange={(e) => updateElement(i, { character: e.target.value.toUpperCase() })} placeholder={t.scriptEditCharacterPlaceholder} />
                <input className="script-edit-field script-parenthetical" value={element.parenthetical} onChange={(e) => updateElement(i, { parenthetical: e.target.value })} placeholder={t.scriptEditParentheticalPlaceholder} />
                <textarea className="script-edit-field script-line" value={element.text} rows={rowsFor(element.text, 35)} onChange={(e) => updateElement(i, { text: e.target.value })} placeholder={t.scriptEditLinePlaceholder} />
              </div>
            ) : element.type === 'transition' ? (
              <input className="script-edit-field script-transition" value={element.text} onChange={(e) => updateElement(i, { text: e.target.value.toUpperCase() })} />
            ) : (
              <textarea className="script-edit-field script-action" value={element.text} rows={rowsFor(element.text, 60)} onChange={(e) => updateElement(i, { text: e.target.value })} placeholder={t.scriptEditActionPlaceholder} />
            )}
            <div className="script-edit-controls">
              <button type="button" onClick={() => insertElement(i, 'action')} title={t.scriptEditAddActionButton}>+ {t.scriptEditActionShort}</button>
              <button type="button" onClick={() => insertElement(i, 'dialogue')} title={t.scriptEditAddDialogueButton}>+ {t.scriptEditDialogueShort}</button>
              <button type="button" onClick={() => removeElement(i)} title={t.scriptEditRemoveButton} aria-label={t.scriptEditRemoveButton}>×</button>
            </div>
          </div>
        ))}
        {editing.elements.length === 0 && (
          <div className="script-edit-controls is-visible">
            <button type="button" onClick={() => insertElement(-1, 'action')}>+ {t.scriptEditActionShort}</button>
            <button type="button" onClick={() => insertElement(-1, 'dialogue')}>+ {t.scriptEditDialogueShort}</button>
          </div>
        )}
        <div className="script-edit-submit-bar">
          <p>{t.movieScriptEditSubmitNote}</p>
          <div>
            <button type="button" className="cancel-button" onClick={() => setEditing(null)} disabled={isSubmittingEdit}>{t.aiMovieReviseSceneCancelButton}</button>
            <button type="button" className="choose-button" onClick={submitEdit} disabled={isSubmittingEdit}>
              {isSubmittingEdit ? t.scriptEditSubmittingLabel : t.scriptEditSubmitButton}
            </button>
          </div>
          {editError && <p className="feedback-note">{editError}</p>}
        </div>
      </div>
    )
  }

  const isChecking = check?.status === 'running'
  // In script order (the check itself runs one language at a time).
  const report = (Array.isArray(check?.report) ? [...check.report] : []).sort(
    (a, b) => (a.episodeIndex ?? -1) - (b.episodeIndex ?? -1) || a.sceneIndex - b.sceneIndex
  )
  const reportFixCount = report.reduce((n, r) => n + (r.fixes?.length ?? 0), 0)
  const sceneLabelFor = (entry) => {
    const g = groups.find((x) => x.episodeIndex === entry.episodeIndex) ?? groups[0]
    const s = g?.scenes?.[entry.sceneIndex]
    return t.movieScriptCheckSceneLabel(numberOf(s, entry.sceneIndex), s ? movieSlugline(s) : '')
  }

  return (
    <div className="movie-screenplay">
      {breakdownStale && <p className="feedback-note movie-breakdown-stale-note">{t.movieBreakdownStaleNote}</p>}

      {allDrafts.length > 0 && (
        <div className={`script-check${isChecking ? ' is-running' : ''}`}>
          <div className="script-check-row">
            <button type="button" className="choose-button" onClick={startCheck} disabled={isChecking}>
              {isChecking ? t.movieScriptCheckRunningLabel(check.doneScenes, check.totalScenes) : t.aiMovieScriptCheckButton}
            </button>
            {!isChecking && check?.status === 'done' && (
              <button type="button" className="cancel-button" onClick={() => setShowReport((v) => !v)}>
                {showReport ? t.aiMovieScriptCheckHideReport : t.movieScriptCheckShowReport(reportFixCount, report.length)}
              </button>
            )}
          </div>
          {isChecking && (
            <div className="script-check-progress" aria-hidden="true">
              <span style={{ width: `${check.totalScenes ? Math.round((check.doneScenes / check.totalScenes) * 100) : 5}%` }} />
            </div>
          )}
          <p className="script-check-note">{isChecking ? t.aiMovieScriptCheckRunningNote : t.movieScriptCheckNote}</p>
          {checkError && <p className="feedback-note">{checkError}</p>}
          {showReport && !isChecking && (
            <div className="script-check-report">
              {report.map((entry, i) => (
                <div key={i} className="script-check-report-beat">
                  <p className="script-check-report-title">{sceneLabelFor(entry)}</p>
                  {entry.error ? (
                    <p className="feedback-note">{t.aiMovieScriptCheckBeatFailed}</p>
                  ) : entry.fixes?.length ? (
                    <ul>{entry.fixes.map((fix, j) => <li key={j}>{fix}</li>)}</ul>
                  ) : (
                    <p className="script-check-note">{entry.changed ? t.movieScriptCheckChangedNote(entry.changed) : t.scriptEditNoFixesNote}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="ai-movie-screenplay-current-card">
        {groups.length > 1 && (
          <div className="ai-movie-screenplay-nav">
            <button type="button" className="ai-movie-screenplay-nav-button" aria-label="Previous episode" disabled={groupIndex === 0}
              onClick={() => { setTurn('prev'); setGroupIndex((i) => Math.max(0, i - 1)) }}>‹</button>
            <p className="bit-heading ai-movie-screenplay-nav-title">{t.episodeLabel} {groupIndex + 1} / {groups.length}{group.title ? `: ${group.title}` : ''}</p>
            <button type="button" className="ai-movie-screenplay-nav-button" aria-label="Next episode" disabled={groupIndex === groups.length - 1}
              onClick={() => { setTurn('next'); setGroupIndex((i) => Math.min(groups.length - 1, i + 1)) }}>›</button>
          </div>
        )}
        <RuntimeSummary total={group.total} target={group.target} t={t} />

        {scenes.length > 0 && (
          <div className="script-workspace">
            <aside className="script-navigator" aria-label={t.scriptScenesTitle}>
              <p className="script-panel-title">{t.scriptScenesTitle}</p>
              <div className="script-navigator-list">
                {scenes.map((s, index) => (
                  <button key={index} type="button" className={`script-nav-item${index === sceneIndex ? ' is-active' : ''}${draftOf(index) ? ' is-written' : ''}`} onClick={() => selectScene(index, true)}>
                    <span className="script-nav-number">{numberOf(s, index)}</span>
                    <span className="script-nav-heading">{movieSlugline(s)}</span>
                    <span className="script-nav-duration">
                      {typeof s.estimatedMinutes === 'number' ? t.aiMovieShortDuration(s.estimatedMinutes) : ''}
                      {draftOf(index) ? '' : ` · ${t.movieScriptNotWrittenShort}`}
                    </span>
                  </button>
                ))}
              </div>
            </aside>

            <div className="script-page-column">
              <div className="script-theme-switch" role="group" aria-label={t.scriptThemeLabel}>
                {['light', 'dark'].map((mode) => (
                  <button key={mode} type="button" className={`script-theme-option${scriptTheme === mode ? ' is-active' : ''}`} onClick={() => onChangeScriptTheme(mode)}>
                    {mode === 'light' ? t.scriptThemeLight : t.scriptThemeDark}
                  </button>
                ))}
              </div>
              <div className="script-stage">
                <div key={`group-${groupIndex}`} className={`script-page script-page-${scriptTheme} script-turn-${turn}`}>
                  {scenes.map((s, index) => {
                    if (editing?.key === keyOf(index)) return renderEditableScene(index, s)
                    const d = draftOf(index)
                    return (
                      <div
                        key={index}
                        id={`movie-script-scene-${index}`}
                        className={`script-scene${index === sceneIndex ? ' is-selected' : ''}${d ? '' : ' is-unwritten'}`}
                        style={{ '--scene-order': index }}
                        onClick={() => selectScene(index, false)}
                        onDoubleClick={() => d && !editing && startEditing(index)}
                        title={d ? t.scriptEditDoubleClickHint : undefined}
                      >
                        <p className="script-slug">
                          <span className="script-scene-number script-scene-number-left">{numberOf(s, index)}</span>
                          {movieSlugline(s)}
                          <span className="script-scene-number script-scene-number-right">{numberOf(s, index)}</span>
                        </p>
                        {d && Array.isArray(d.elements) ? (
                          renderElements(d.elements)
                        ) : (
                          <p className="script-outline">{s.oneLiner?.[language] ?? s.oneLiner?.en ?? ''} <span>— {t.movieScriptNotWrittenLabel}</span></p>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            <aside className="script-tools" aria-label={t.scriptSelectedSceneTitle(numberOf(scene, sceneIndex))}>
              <p className="script-panel-title">{t.scriptSelectedSceneTitle(numberOf(scene, sceneIndex))}</p>
              <p className="script-tools-heading">{scene ? movieSlugline(scene) : ''}</p>
              <div className="script-tools-meta" key={`meta-${groupIndex}-${sceneIndex}`}>
                {typeof scene?.estimatedMinutes === 'number' && <span>{t.aiMovieSceneDurationLabel(scene.estimatedMinutes)}</span>}
                {scene?.purpose && <span>{t.scenePurposeLabels[scene.purpose]}</span>}
                {scene?.oneLiner && <span><strong>{t.movieScriptOutlineLabel}:</strong> {scene.oneLiner[language] ?? scene.oneLiner.en}</span>}
                {scene?.turn && <span>{t.sceneTurnLabel}: {scene.turn[language] ?? scene.turn.en}</span>}
                {draft?.charactersPresent?.length > 0 && <span>{t.screenplayCharactersLabel}: {draft.charactersPresent.join(', ')}</span>}
                {draft?.dialogueLanguage && <span>{draft.dialogueLanguage === 'or' ? t.dialogueLanguageOdia : draft.dialogueLanguage === 'hi' ? t.dialogueLanguageHindi : t.dialogueLanguageEnglish}</span>}
              </div>
              <div className="script-tools-actions">
                {!screenplay ? (
                  <p className="script-tools-editing-note">{t.movieScriptApproveFirstNote}</p>
                ) : !draft ? (
                  <ScreenplayBlock episodeIndex={group.episodeIndex} sceneIndex={sceneIndex} t={t} language={language} screenplay={screenplay} />
                ) : (
                  <>
                    {editing?.key === selectedKey ? (
                      <p className="script-tools-editing-note">{t.scriptEditEditingNote}</p>
                    ) : (
                      <button type="button" className="choose-button script-edit-start-button" onClick={() => startEditing(sceneIndex)} disabled={Boolean(editing) || isAiWriting || isChecking}>
                        {t.scriptEditStartButton}
                      </button>
                    )}
                    {editFixes?.key === selectedKey && (
                      <div className="script-edit-fixes">
                        <p className="script-panel-title">{t.scriptEditFixesTitle}</p>
                        {editFixes.fixes.length === 0 ? <p>{t.scriptEditNoFixesNote}</p> : <ul>{editFixes.fixes.map((fix, i) => <li key={i}>{fix}</li>)}</ul>}
                      </div>
                    )}
                    <ScreenplayBlock episodeIndex={group.episodeIndex} sceneIndex={sceneIndex} t={t} language={language} screenplay={screenplay} toolsOnly />
                  </>
                )}
              </div>
              {screenplay && (
                <div className="script-scene-manage">
                  <p className="script-panel-title">{t.sceneManageTitle}</p>
                  {sceneForm ? (
                    <form className="script-scene-form" onSubmit={(event) => { event.preventDefault(); submitNewScene(true) }}>
                      <p className="script-tools-heading">{t.sceneNewTitle(sceneForm.position + 1)}</p>
                      <label>
                        {t.sceneNewIntExtLabel}
                        <select value={sceneForm.intExt} onChange={(event) => setSceneForm({ ...sceneForm, intExt: event.target.value })}>
                          <option value="INT">{t.sceneNewInt}</option>
                          <option value="EXT">{t.sceneNewExt}</option>
                        </select>
                      </label>
                      <label>
                        {t.sceneNewLocationLabel}
                        <input type="text" value={sceneForm.location} placeholder={t.sceneNewLocationPlaceholder} onChange={(event) => setSceneForm({ ...sceneForm, location: event.target.value })} />
                      </label>
                      <label>
                        {t.sceneNewTimeLabel}
                        <select value={sceneForm.timeOfDay} onChange={(event) => setSceneForm({ ...sceneForm, timeOfDay: event.target.value })}>
                          {Object.entries(t.sceneNewTimeOptions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                      </label>
                      <label>
                        {t.sceneNewWhatLabel}
                        <textarea rows={3} value={sceneForm.oneLiner} placeholder={t.sceneNewWhatPlaceholder} onChange={(event) => setSceneForm({ ...sceneForm, oneLiner: event.target.value })} />
                      </label>
                      <label>
                        {t.sceneNewMinutesLabel}
                        <input type="number" min="0.5" max="15" step="0.5" value={sceneForm.estimatedMinutes} onChange={(event) => setSceneForm({ ...sceneForm, estimatedMinutes: event.target.value })} />
                      </label>
                      <div className="script-scene-form-actions">
                        <button type="submit" className="choose-button" disabled={isChangingScenes || !sceneForm.location.trim() || !sceneForm.oneLiner.trim()}>
                          {isChangingScenes ? t.sceneNewSavingLabel : t.sceneNewWriteAiButton}
                        </button>
                        <button type="button" className="cancel-button" onClick={() => submitNewScene(false)} disabled={isChangingScenes || !sceneForm.location.trim() || !sceneForm.oneLiner.trim()}>
                          {t.sceneNewBlankButton}
                        </button>
                        <button type="button" className="cancel-button" onClick={() => setSceneForm(null)} disabled={isChangingScenes}>
                          {t.sceneNewCancelButton}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="script-scene-manage-buttons">
                      <button type="button" className="cancel-button" onClick={() => openSceneForm(sceneIndex)} disabled={Boolean(editing) || isAiWriting || isChecking || isChangingScenes}>
                        {t.sceneAddBeforeButton}
                      </button>
                      <button type="button" className="cancel-button" onClick={() => openSceneForm(sceneIndex + 1)} disabled={Boolean(editing) || isAiWriting || isChecking || isChangingScenes}>
                        {t.sceneAddAfterButton}
                      </button>
                      <button type="button" className="cancel-button script-scene-delete-button" onClick={deleteSelectedScene} disabled={Boolean(editing) || isAiWriting || isChecking || isChangingScenes || scenes.length < 2}>
                        {t.sceneDeleteButton}
                      </button>
                    </div>
                  )}
                  {sceneChangeError && <p className="error-text">{sceneChangeError}</p>}
                  {scenesMoved && !sceneForm && <p className="script-tools-editing-note">{t.sceneNewNoteAfterChange}</p>}
                </div>
              )}
            </aside>
          </div>
        )}
      </div>

      {createPortal(
        <div className={`script-letterbox-layer${isAiWriting ? ' is-ai-writing' : ''}`} aria-hidden="true">
          <div className="script-letterbox script-letterbox-top" />
          <div className="script-letterbox script-letterbox-bottom">
            <span className="script-letterbox-label">{t.scriptAiWritingLabel}</span>
          </div>
        </div>,
        document.body
      )}
    </div>
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
  const [isCameraOpen, setIsCameraOpen] = useState(false)

  return (
    <div className="crew-member-card crew-member-card-editing">
      {editPhotoFile ? (
        <img className="crew-member-photo" src={URL.createObjectURL(editPhotoFile)} alt={editName} />
      ) : member.photoUrl ? (
        <img className="crew-member-photo" src={member.photoUrl} alt={member.name} />
      ) : (
        <div className="crew-member-photo crew-member-photo-placeholder">{member.name.charAt(0).toUpperCase()}</div>
      )}
      <div className="crew-member-edit-fields">
        <MicInput placeholder={t.crewNameLabel} value={editName} onChange={(e) => setEditName(e.target.value)} />
        {showRole && (
          <MicInput placeholder={t.crewRoleLabel} value={editRole} onChange={(e) => setEditRole(e.target.value)} />
        )}
        <input type="tel" placeholder={t.crewContactLabel} value={editContactNumber} onChange={(e) => setEditContactNumber(e.target.value)} />
        <div className="photo-input-row">
          <input type="file" accept="image/*" onChange={(e) => setEditPhotoFile(e.target.files[0] ?? null)} />
          <button type="button" className="camera-trigger-button" onClick={() => setIsCameraOpen(true)} title={t.useCameraLabel}>
            {ICONS.camera}
          </button>
        </div>
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
      {isCameraOpen && (
        <CameraCaptureModal
          t={t}
          onCapture={(file) => {
            setEditPhotoFile(file)
            setIsCameraOpen(false)
          }}
          onClose={() => setIsCameraOpen(false)}
        />
      )}
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
  const [isCameraOpen, setIsCameraOpen] = useState(false)
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
              <MicInput placeholder={t.crewNameLabel} value={name} onChange={(e) => setName(e.target.value)} />
              {!characterOptions && (
                <MicInput placeholder={t.crewRoleLabel} value={role} onChange={(e) => setRole(e.target.value)} />
              )}
              <input type="tel" placeholder={t.crewContactLabel} value={contactNumber} onChange={(e) => setContactNumber(e.target.value)} />
              <input
                type="file"
                accept="image/*"
                ref={fileInputRef}
                onChange={(e) => setPhotoFile(e.target.files[0] ?? null)}
              />
              <button
                type="button"
                className="camera-trigger-button"
                onClick={() => setIsCameraOpen(true)}
                title={t.useCameraLabel}
              >
                {ICONS.camera}
              </button>
              {photoFile && <span className="photo-file-selected-note">{photoFile.name}</span>}
              <button className="breakdown-action-button" type="submit" disabled={isAdding || !name.trim()}>
                {t.addCrewMemberButton}
              </button>
            </form>
          )}
        </>
      )}
      {isCameraOpen && (
        <CameraCaptureModal
          t={t}
          onCapture={(file) => {
            setPhotoFile(file)
            setIsCameraOpen(false)
          }}
          onClose={() => setIsCameraOpen(false)}
        />
      )}
    </div>
  )
}

// A live camera capture, used everywhere a photo can be attached (chat,
// adding cast/location/crew, editing an existing member's photo) as an
// alternative to picking a file. Requests { facingMode: { ideal:
// 'environment' } } — on a phone with a back camera that opens the back
// camera directly (no gallery/roll detour); on a laptop with only one
// (front-facing) camera the "ideal" constraint is simply unsatisfiable so
// the browser falls back to that camera instead of failing. No manual
// desktop-vs-mobile detection needed. The captured frame becomes a plain
// File, used exactly like a normal file-picker selection downstream.
// multiple=false (the default, used when adding a single cast/location/crew
// photo): capturing immediately hands that one file back via onCapture and
// the caller closes the modal. multiple=true (the chat box, for a
// multi-page handwritten note like several pages of a Day 2 schedule):
// each capture is added to a running batch shown as removable thumbnails
// right in the modal — the camera stays live so the AD can keep
// photographing page after page — and onCapture is only called once, with
// the whole batch array, when they click Done.
function CameraCaptureModal({ t, onCapture, onClose, multiple = false }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [error, setError] = useState(null)
  const [isReady, setIsReady] = useState(false)
  const [capturedFiles, setCapturedFiles] = useState([])

  useEffect(() => {
    let cancelled = false
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(t.cameraNotAvailableError)
      return undefined
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
        setIsReady(true)
      })
      .catch(() => {
        if (!cancelled) setError(t.cameraAccessError)
      })
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [t])

  function handleCaptureClick() {
    const video = videoRef.current
    if (!video) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
    canvas.toBlob(
      (blob) => {
        if (!blob) return
        const file = new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' })
        if (multiple) {
          setCapturedFiles((prev) => [...prev, file])
        } else {
          onCapture(file)
        }
      },
      'image/jpeg',
      0.92
    )
  }

  function handleRemoveCapturedClick(index) {
    setCapturedFiles((prev) => prev.filter((_, i) => i !== index))
  }

  return (
    <div className="camera-modal-overlay" onClick={onClose}>
      <div className="camera-modal" onClick={(e) => e.stopPropagation()}>
        <div className="camera-modal-header">
          <strong>{t.cameraModalHeading}</strong>
          <button className="changes-chat-close" onClick={onClose} type="button">
            ✕
          </button>
        </div>
        {error ? (
          <p className="feedback-note">{error}</p>
        ) : (
          <video ref={videoRef} autoPlay playsInline muted className="camera-modal-video" />
        )}
        {multiple && capturedFiles.length > 0 && (
          <div className="camera-modal-captured-list">
            {capturedFiles.map((file, i) => (
              <div className="camera-modal-captured-thumb" key={i}>
                <img src={URL.createObjectURL(file)} alt="" />
                <button onClick={() => handleRemoveCapturedClick(i)} type="button" title={t.removeCostumeSetButton}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="camera-modal-controls">
          <button className="choose-button" onClick={handleCaptureClick} disabled={!isReady} type="button">
            {multiple && capturedFiles.length > 0 ? t.captureAnotherButtonLabel : t.captureButtonLabel}
          </button>
          {multiple && (
            <button
              className="choose-button"
              onClick={() => onCapture(capturedFiles)}
              disabled={capturedFiles.length === 0}
              type="button"
            >
              {t.doneCapturingButtonLabel} {capturedFiles.length > 0 ? `(${capturedFiles.length})` : ''}
            </button>
          )}
          <button className="cancel-button" onClick={onClose} type="button">
            {t.cancelEditButton}
          </button>
        </div>
      </div>
    </div>
  )
}

// A single "Download" link that, on click, pops up a small PDF/Excel
// choice instead of downloading immediately — every export in the app used
// to be a bare link straight to one format; this replaces that with one
// consistent choice point wherever a download is offered.
function DownloadChoiceButton({ t, label, pdfUrl, excelUrl, className = 'breakdown-pdf-link', title, pdfLabel, excelLabel }) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef(null)

  useEffect(() => {
    if (!isOpen) return
    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  return (
    <div className="download-choice" ref={containerRef}>
      <button type="button" className={`${className} download-choice-trigger`} onClick={() => setIsOpen((open) => !open)} title={title}>
        {label}
      </button>
      {isOpen && (
        <div className="download-choice-menu">
          <a className="download-choice-option" href={pdfUrl} onClick={() => setIsOpen(false)}>
            {pdfLabel ?? t.downloadFormatPdf}
          </a>
          <a className="download-choice-option" href={excelUrl} onClick={() => setIsOpen(false)}>
            {excelLabel ?? t.downloadFormatExcel}
          </a>
        </div>
      )}
    </div>
  )
}

// The on-set digital clapboard — a true full-screen white slate modeled on
// a real acrylic clapboard (banner where the colored clapper-stick would
// be, then SCENE/SHOT/TAKE, then DATE/DAY-NIGHT), not an embedded page
// section. Tapping CLAP plays a short beep (a real slate's audio "sync
// mark" — the beep and the visual clap both need to be sharp and instant,
// which is why this uses the Web Audio API directly rather than an audio
// file: zero load latency, and no asset to ship) and logs the clap to the
// server. The scene field is a hybrid — pick one of today's scheduled
// scenes from the dropdown, or just type a scene number by hand.
function ClapboardFullScreen({ t, BACKEND_URL, conceptId, sceneListId, sceneOptions, onClose, bannerUrl, onBannerUpdated, canEditProduction }) {
  const [isUploadingBanner, setIsUploadingBanner] = useState(false)
  const bannerFileInputRef = useRef(null)

  async function handleBannerFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    setIsUploadingBanner(true)
    try {
      const formData = new FormData()
      formData.append('banner', file)
      const response = await fetch(`${BACKEND_URL}/api/concept/${conceptId}/clapboard-banner`, {
        method: 'POST',
        body: formData,
      })
      const data = await response.json()
      if (response.ok) onBannerUpdated?.(data.clapboardBannerUrl)
    } catch {
      // Silently ignored — the banner just stays as it was; the AD can retry.
    }
    setIsUploadingBanner(false)
  }

  const [sceneNumber, setSceneNumber] = useState('')
  const [shotNumber, setShotNumber] = useState('1')
  const [takeNumber, setTakeNumber] = useState(1)
  const [dayNight, setDayNight] = useState('DAY')
  // Day/Month/Year as separate fields, not a native <input type="date"> —
  // that control displays in whatever order the browser's locale prefers
  // (which is why this showed up as MM/DD for the AD), and there's no
  // cross-browser way to force it to a specific order. Split fields give
  // total control over DD/MM/YYYY everywhere.
  const today = new Date()
  const [dateDay, setDateDay] = useState(String(today.getDate()).padStart(2, '0'))
  const [dateMonth, setDateMonth] = useState(String(today.getMonth() + 1).padStart(2, '0'))
  const [dateYear, setDateYear] = useState(String(today.getFullYear()))
  const [isClapping, setIsClapping] = useState(false)
  const [history, setHistory] = useState([])
  const [isLoadingHistory, setIsLoadingHistory] = useState(true)
  const [isHistoryOpen, setIsHistoryOpen] = useState(false)
  const [logError, setLogError] = useState(null)
  const [isForcedLandscape, setIsForcedLandscape] = useState(false)
  const [isTimecodeRunning, setIsTimecodeRunning] = useState(false)
  const [timecodeStartedAt, setTimecodeStartedAt] = useState(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const audioContextRef = useRef(null)
  const containerRef = useRef(null)

  // Tap Shoot to start the timecode running, tap again to stop it — the
  // interval only exists while isTimecodeRunning is true, so stopping just
  // freezes elapsedMs at whatever it last read instead of resetting it.
  useEffect(() => {
    if (!isTimecodeRunning) return
    const interval = setInterval(() => setElapsedMs(Date.now() - timecodeStartedAt), 30)
    return () => clearInterval(interval)
  }, [isTimecodeRunning, timecodeStartedAt])

  // The real Fullscreen + Orientation Lock APIs are unreliable on mobile —
  // iOS Safari doesn't support element-level requestFullscreen at all, and
  // orientation lock only works inside an actual fullscreen context on a
  // handful of Android browsers. So expand does two things: attempts the
  // real API as a bonus (hides browser chrome where it's actually
  // supported), and ALSO applies a pure-CSS 90° rotation that fills the
  // screen with the landscape layout regardless of whether either API
  // worked — this part always works, on every mobile browser, since it's
  // just a transform, not a browser feature that can be missing.
  async function handleExpandClick() {
    if (isForcedLandscape) {
      setIsForcedLandscape(false)
      if (document.fullscreenElement) {
        try { await document.exitFullscreen?.() } catch { /* ignore */ }
      }
      return
    }
    setIsForcedLandscape(true)
    try {
      await containerRef.current?.requestFullscreen?.()
      if (screen.orientation?.lock) {
        screen.orientation.lock('landscape').catch(() => {})
      }
    } catch {
      // Real fullscreen denied/unsupported — the CSS rotation still applies.
    }
  }

  useEffect(() => {
    function handleFullscreenChange() {
      // The system back gesture / browser's own fullscreen-exit control can
      // leave fullscreen without going through handleExpandClick — drop the
      // forced rotation too so the two states can't get out of sync.
      if (!document.fullscreenElement) setIsForcedLandscape(false)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      if (document.fullscreenElement) document.exitFullscreen?.()
      if (screen.orientation?.unlock) screen.orientation.unlock()
    }
  }, [])

  // If the AD physically rotates the phone into real landscape while the
  // forced CSS rotation is active, drop the forced rotation so the two
  // don't fight each other and turn the content sideways again.
  useEffect(() => {
    if (!isForcedLandscape) return
    const query = window.matchMedia('(orientation: landscape)')
    function handleChange(e) { if (e.matches) setIsForcedLandscape(false) }
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [isForcedLandscape])

  useEffect(() => {
    let cancelled = false
    async function loadHistory() {
      setIsLoadingHistory(true)
      try {
        const res = await fetch(`${BACKEND_URL}/api/clapboard/${sceneListId}/log`, { credentials: 'include' })
        if (res.ok && !cancelled) setHistory(await res.json())
      } catch {
        // Silent — the log is a nice-to-have review list, not core to using the slate.
      } finally {
        if (!cancelled) setIsLoadingHistory(false)
      }
    }
    loadHistory()
    return () => { cancelled = true }
  }, [BACKEND_URL, sceneListId])

  useEffect(() => {
    function handleEscape(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [onClose])

  function playBeep() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      if (!audioContextRef.current) audioContextRef.current = new AudioCtx()
      const ctx = audioContextRef.current
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()
      oscillator.type = 'square'
      oscillator.frequency.value = 1000
      gain.gain.setValueAtTime(0.5, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18)
      oscillator.connect(gain)
      gain.connect(ctx.destination)
      oscillator.start()
      oscillator.stop(ctx.currentTime + 0.18)
    } catch {
      // Some browsers block audio until a user gesture has happened at all —
      // the clap itself still logs and animates even if the beep can't play.
    }
  }

  async function handleClapClick() {
    // First tap: clap (beep + log) and start the timecode running.
    // Second tap: just stop it where it is — no new clap, no reset.
    if (isTimecodeRunning) {
      setIsTimecodeRunning(false)
      return
    }

    playBeep()
    setIsClapping(true)
    setTimeout(() => setIsClapping(false), 220)
    setTimecodeStartedAt(Date.now())
    setElapsedMs(0)
    setIsTimecodeRunning(true)

    try {
      const res = await fetch(`${BACKEND_URL}/api/clapboard/${sceneListId}/log`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneNumber, shotNumber, takeNumber, dayNight, date: `${dateYear}-${dateMonth}-${dateDay}` }),
      })
      if (res.ok) {
        const saved = await res.json()
        setHistory((h) => [saved, ...h])
        setTakeNumber((n) => n + 1)
        setLogError(null)
      } else {
        setLogError(t.clapboardLogError)
      }
    } catch {
      setLogError(t.clapboardLogError)
    }
  }

  function formatTimecode(ms) {
    const totalCentiseconds = Math.floor(ms / 10)
    const centiseconds = totalCentiseconds % 100
    const totalSeconds = Math.floor(totalCentiseconds / 100)
    const seconds = totalSeconds % 60
    const minutes = Math.floor(totalSeconds / 60)
    const pad = (n, len = 2) => String(n).padStart(len, '0')
    return `${pad(minutes)}:${pad(seconds)}.${pad(centiseconds)}`
  }

  function adjustShot(delta) {
    setShotNumber((current) => String(Math.max(1, (parseInt(current, 10) || 1) + delta)))
  }
  function adjustTake(delta) {
    setTakeNumber((current) => Math.max(1, current + delta))
  }

  return (
    <div className={isForcedLandscape ? 'clapboard-fullscreen force-landscape' : 'clapboard-fullscreen'} ref={containerRef}>
      <button type="button" className="clapboard-close-button" onClick={onClose} aria-label="Close">✕</button>
      <button type="button" className="clapboard-history-toggle" onClick={() => setIsHistoryOpen((o) => !o)}>
        {t.clapboardHistoryHeading}
      </button>
      <button type="button" className="clapboard-expand-button" onClick={handleExpandClick} aria-label="Expand">
        {isForcedLandscape ? '⤡' : '⤢'}
      </button>

      <div className={isClapping ? 'clapboard-board clapping' : 'clapboard-board'}>
        <div className="clapboard-board-left">
        <div className="clapboard-banner-wrap">
          {bannerUrl ? (
            <img src={bannerUrl} alt="" className="clapboard-banner" />
          ) : (
            <div className="clapboard-banner-placeholder">{t.clapboardNoBannerLabel}</div>
          )}
          {canEditProduction && (
            <>
              <button
                type="button"
                className="clapboard-banner-edit-button"
                onClick={() => bannerFileInputRef.current?.click()}
                disabled={isUploadingBanner}
              >
                {isUploadingBanner ? t.clapboardUploadingBannerLabel : t.clapboardChangeBannerButton}
              </button>
              <input
                ref={bannerFileInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handleBannerFileChange}
              />
            </>
          )}
        </div>

        <div className="clapboard-table">
          <div className="clapboard-table-row clapboard-table-header">
            <div>{t.clapboardSceneLabel.toUpperCase()} NO.</div>
            <div>{t.clapboardShotLabel.toUpperCase()} NO.</div>
            <div>{t.clapboardTakeLabel.toUpperCase()} NO.</div>
          </div>
          <div className="clapboard-table-row clapboard-table-values">
            <div className="clapboard-scene-cell">
              {sceneOptions.length > 0 && (
                <select
                  className="clapboard-scene-select"
                  value=""
                  onChange={(e) => { if (e.target.value) setSceneNumber(e.target.value) }}
                >
                  <option value="">{t.clapboardPickFromSchedule}</option>
                  {sceneOptions.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              )}
              <input
                type="text"
                className="clapboard-cell-input"
                value={sceneNumber}
                onChange={(e) => setSceneNumber(e.target.value)}
                placeholder={t.clapboardSceneManualPlaceholder}
              />
            </div>
            <div className="clapboard-counter-row">
              <button type="button" onClick={() => adjustShot(-1)}>−</button>
              <input className="clapboard-cell-input" value={shotNumber} onChange={(e) => setShotNumber(e.target.value)} />
              <button type="button" onClick={() => adjustShot(1)}>+</button>
            </div>
            <div className="clapboard-counter-row">
              <button type="button" onClick={() => adjustTake(-1)}>−</button>
              <input className="clapboard-cell-input" value={takeNumber} onChange={(e) => setTakeNumber(parseInt(e.target.value, 10) || 1)} />
              <button type="button" onClick={() => adjustTake(1)}>+</button>
            </div>
          </div>
          <div className="clapboard-table-row clapboard-table-footer">
            <div className="clapboard-date-cell">
              <input
                type="text"
                inputMode="numeric"
                maxLength={2}
                className="clapboard-cell-input clapboard-date-input"
                value={dateDay}
                onChange={(e) => setDateDay(e.target.value.replace(/\D/g, '').slice(0, 2))}
                placeholder="DD"
              />
              <span className="clapboard-date-sep">/</span>
              <input
                type="text"
                inputMode="numeric"
                maxLength={2}
                className="clapboard-cell-input clapboard-date-input"
                value={dateMonth}
                onChange={(e) => setDateMonth(e.target.value.replace(/\D/g, '').slice(0, 2))}
                placeholder="MM"
              />
              <span className="clapboard-date-sep">/</span>
              <input
                type="text"
                inputMode="numeric"
                maxLength={4}
                className="clapboard-cell-input clapboard-date-input clapboard-date-year"
                value={dateYear}
                onChange={(e) => setDateYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="YYYY"
              />
            </div>
            <div className="clapboard-daynight-cell">
              <button type="button" className={dayNight === 'DAY' ? 'clapboard-daynight-button active' : 'clapboard-daynight-button'} onClick={() => setDayNight('DAY')}>DAY</button>
              <button type="button" className={dayNight === 'NIGHT' ? 'clapboard-daynight-button active' : 'clapboard-daynight-button'} onClick={() => setDayNight('NIGHT')}>NIGHT</button>
            </div>
            <div
              className={isTimecodeRunning ? 'clapboard-tap-zone running' : 'clapboard-tap-zone'}
              onClick={handleClapClick}
              role="button"
              tabIndex={0}
            >
              <div className="clapboard-timecode">{formatTimecode(elapsedMs)}</div>
              <div className="clapboard-tap-hint">{isTimecodeRunning ? t.clapboardTapHintStop : t.clapboardTapHintStart}</div>
            </div>
          </div>
        </div>
        </div>
        {logError && <p className="clapboard-error">{logError}</p>}
      </div>

      {isHistoryOpen && (
        <div className="clapboard-history-drawer">
          <h4>{t.clapboardHistoryHeading}</h4>
          {isLoadingHistory ? (
            <p className="clapboard-history-empty">{t.loadingLabel}</p>
          ) : history.length === 0 ? (
            <p className="clapboard-history-empty">{t.clapboardHistoryEmpty}</p>
          ) : (
            <ul className="clapboard-history-list">
              {history.map((entry) => (
                <li key={entry.id}>
                  <strong>{entry.sceneNumber || '—'}</strong>
                  {' · '}{t.clapboardShotLabel} {entry.shotNumber || '—'}
                  {' · '}{t.clapboardTakeLabel} {entry.takeNumber}
                  <span className="clapboard-history-time">{new Date(entry.createdAt).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

const CHANGES_CHAT_TOGGLE_POSITION_STORAGE_KEY = 'filmmaking-app:changesChatTogglePosition'

// Same drag mechanics as FloatingAgentWidget's button above — the pen icon
// that opens the Changes chat is a floating button you can drag anywhere,
// not one nailed to a fixed screen corner. Position is a per-viewer
// localStorage convenience, same as the auto-pipeline widget's.
function useDraggableTogglePosition(storageKey, defaultPosition) {
  const [position, setPosition] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      if (saved) return JSON.parse(saved)
    } catch {
      // ignore — fall through to default
    }
    return typeof defaultPosition === 'function' ? defaultPosition() : defaultPosition
  })
  const [isDragging, setIsDragging] = useState(false)
  const dragOffset = useRef({ x: 0, y: 0 })
  const dragStart = useRef({ x: 0, y: 0 })
  const hasDraggedRef = useRef(false)

  function handlePointerDown(e) {
    setIsDragging(true)
    hasDraggedRef.current = false
    dragStart.current = { x: e.clientX, y: e.clientY }
    dragOffset.current = { x: e.clientX - position.x, y: e.clientY - position.y }
  }

  useEffect(() => {
    if (!isDragging) return undefined

    function handleMove(e) {
      if (Math.abs(e.clientX - dragStart.current.x) > 5 || Math.abs(e.clientY - dragStart.current.y) > 5) {
        hasDraggedRef.current = true
      }
      setPosition({ x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y })
    }
    function handleUp() {
      setIsDragging(false)
      setPosition((current) => {
        try {
          localStorage.setItem(storageKey, JSON.stringify(current))
        } catch {
          // per-viewer convenience only — fine if it can't persist
        }
        return current
      })
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
  }, [isDragging, storageKey])

  return { position, handlePointerDown, hasDraggedRef }
}

// Web Speech API doesn't auto-detect which language is being spoken — one
// recognition session must be told a single language up front. So instead
// of guessing, the person picks English/Hindi/Odia once via the small
// dropdown next to the mic, and that choice is remembered (localStorage)
// as their default for next time.
const DICTATION_BCP47_BY_LANGUAGE = { en: 'en-IN', hi: 'hi-IN', or: 'or-IN' }

// Dictation for any text box — uses the browser's built-in Web Speech API
// (Chrome and Android's Chromium WebView both ship it, free, no API key,
// no server round-trip). Renders nothing if the browser doesn't support it
// (Safari/Firefox), rather than showing a mic that can't work. English and
// Hindi recognition are both reliable; Odia support varies by device/OS.
function MicButton({ t, dictationLanguage, onDictationLanguageChange, onResult, className, wrapClassName, title, listeningTitle }) {
  const [isListening, setIsListening] = useState(false)
  const recognitionRef = useRef(null)

  const SpeechRecognitionImpl =
    typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null

  function handleClick() {
    if (!SpeechRecognitionImpl) return

    if (isListening) {
      recognitionRef.current?.stop()
      return
    }

    const recognition = new SpeechRecognitionImpl()
    recognition.lang = DICTATION_BCP47_BY_LANGUAGE[dictationLanguage] ?? 'en-IN'
    recognition.interimResults = false
    recognition.maxAlternatives = 1
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0].transcript)
        .join(' ')
        .trim()
      if (transcript) onResult(transcript)
    }
    recognition.onend = () => setIsListening(false)
    recognition.onerror = () => setIsListening(false)
    recognitionRef.current = recognition
    recognition.start()
    setIsListening(true)
  }

  if (!SpeechRecognitionImpl) return null

  return (
    <span className={wrapClassName}>
      <select
        className="mic-language-select"
        value={dictationLanguage}
        onChange={(e) => onDictationLanguageChange(e.target.value)}
        title={t.micLanguageSelectTitle}
      >
        <option value="en">{t.micLanguageEnglish}</option>
        <option value="hi">{t.micLanguageHindi}</option>
        <option value="or">{t.micLanguageOdia}</option>
      </select>
      <button
        type="button"
        className={isListening ? `${className} mic-button-listening` : className}
        onClick={handleClick}
        title={isListening ? listeningTitle : title}
      >
        {ICONS.mic}
      </button>
    </span>
  )
}

// Drop-in replacements for a plain <input type="text"> / <textarea> that add
// a mic button in the corner — same value/onChange contract as the native
// element (onChange still receives a real change event with .target.value),
// so swapping one in doesn't require touching whatever the existing
// onChange handler does. dictationLanguage/onDictationLanguageChange/t are
// threaded down from the top-level App component via context so every one
// of these across the whole app shares one remembered language choice.
function MicInput({ value, onChange, className, wrapClassName, ...rest }) {
  const { t, dictationLanguage, onDictationLanguageChange } = useDictationContext()
  return (
    <span className={wrapClassName ? `mic-field-wrap ${wrapClassName}` : 'mic-field-wrap'}>
      <input
        type="text"
        className={className}
        value={value}
        onChange={onChange}
        {...rest}
      />
      <MicButton
        t={t}
        dictationLanguage={dictationLanguage}
        onDictationLanguageChange={onDictationLanguageChange}
        wrapClassName="mic-field-mic-wrap"
        className="mic-field-mic"
        title={t.micButtonTitle}
        listeningTitle={t.micButtonListeningTitle}
        onResult={(text) => onChange({ target: { value: value && value.trim() ? `${value.trim()} ${text}` : text } })}
      />
    </span>
  )
}

function MicTextarea({ value, onChange, className, wrapClassName, ...rest }) {
  const { t, dictationLanguage, onDictationLanguageChange } = useDictationContext()
  return (
    <span className={wrapClassName ? `mic-field-wrap mic-field-wrap-textarea ${wrapClassName}` : 'mic-field-wrap mic-field-wrap-textarea'}>
      <textarea className={className} value={value} onChange={onChange} {...rest} />
      <MicButton
        t={t}
        dictationLanguage={dictationLanguage}
        onDictationLanguageChange={onDictationLanguageChange}
        wrapClassName="mic-field-mic-wrap"
        className="mic-field-mic"
        title={t.micButtonTitle}
        listeningTitle={t.micButtonListeningTitle}
        onResult={(text) => onChange({ target: { value: value && value.trim() ? `${value.trim()} ${text}` : text } })}
      />
    </span>
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
function ChangesChatPanel({ t, historyKey, barConfig, isBusy, errorMessage, currentUserName, openSignal, clearDraftHistorySignal, dictationLanguage, onDictationLanguageChange }) {
  const [isOpen, setIsOpen] = useState(false)
  const { position, handlePointerDown, hasDraggedRef } = useDraggableTogglePosition(
    CHANGES_CHAT_TOGGLE_POSITION_STORAGE_KEY,
    () => ({ x: window.innerWidth - 80, y: window.innerHeight - 80 })
  )
  const [historiesByKey, setHistoriesByKey] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('filmmaking-app:chatHistories') || '{}')
    } catch {
      return {}
    }
  })
  const wasBusyRef = useRef(false)
  const messagesEndRef = useRef(null)

  function handleToggleClick() {
    if (hasDraggedRef.current) return
    setIsOpen((v) => !v)
  }

  useEffect(() => {
    if (openSignal) setIsOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal])

  // A project has no id yet until its first successful generation, so its
  // chat history is filed under a placeholder "new:<stage>" key. Without
  // this, starting a fresh idea after abandoning a previous unsaved one
  // would resurface that previous attempt's messages — they share the same
  // placeholder. "New Idea" bumps this signal to actually delete that
  // placeholder bucket, not just hide it.
  useEffect(() => {
    if (!clearDraftHistorySignal) return
    setHistoriesByKey((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([key]) => !key.startsWith('new:')))
      try {
        localStorage.setItem('filmmaking-app:chatHistories', JSON.stringify(next))
      } catch {
        // Private-browsing/storage-blocked — fine, nothing to clean up then.
      }
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearDraftHistorySignal])

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
      // A submit handler clears the global error at its own start and only
      // ever sets it again on ITS OWN failure — so by the time busy flips
      // back to false in the same update, this reliably reflects whether
      // THIS submission succeeded, not some unrelated stale error.
      appendMessage({
        role: 'system',
        text: errorMessage ? `${t.changesChatErrorMessage} ${errorMessage}` : t.changesChatAppliedMessage,
      })
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
      <button
        className="changes-chat-toggle"
        style={{ left: position.x, top: position.y }}
        onPointerDown={handlePointerDown}
        onClick={handleToggleClick}
        title={t.changesChatToggleLabel}
      >
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
          {messages.length === 0 && (
            <div className="agent-chat-greeting">
              <p className="agent-chat-greeting-hi">{currentUserName ? `${t.agentChatGreetingHi} ${currentUserName}` : t.agentChatGreetingHi}</p>
              <p className="agent-chat-greeting-prompt">{t.changesChatEmptyNote}</p>
            </div>
          )}
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
          <AnalyzingProgressBar active={isBusy} label={t.changesChatWorkingLabel} estimatedSeconds={30} />
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
          <MicButton
            t={t}
            dictationLanguage={dictationLanguage}
            onDictationLanguageChange={onDictationLanguageChange}
            wrapClassName="changes-chat-mic-wrap"
            className="changes-chat-mic"
            title={t.micButtonTitle}
            listeningTitle={t.micButtonListeningTitle}
            onResult={(text) => barConfig.onChange(barConfig.value.trim() ? `${barConfig.value.trim()} ${text}` : text)}
          />
          <button
            className={barConfig.stageKey === 'idea' ? 'changes-chat-send changes-chat-send-labeled' : 'changes-chat-send'}
            onClick={handleSend}
            disabled={!barConfig.canSubmit}
          >
            {isBusy ? '…' : barConfig.stageKey === 'idea' ? t.generateIdeaButton : '↵'}
          </button>
        </div>
      </div>
    </>
  )
}

// The real conversational agent — server-persisted history shared by every
// login, backed by the /api/agent-chat/... endpoints — replacing
// ChangesChatPanel for the 'schedule' and 'breakdown' stages, the only ones
// with a wired-up agent right now. Visually it reuses the exact same
// classes/hover-open behavior as ChangesChatPanel so the rest of the app
// doesn't need to know two different chat mechanisms exist. A photo can be
// attached right in the input — a handwritten AD note, or a person's photo
// for a casting decision — instead of a separate upload button elsewhere.
function AgentChatPanel({ t, BACKEND_URL, conceptId, stageKey, currentUserName, onScheduleUpdated, onCastMemberUpdated, onBreakdownUpdated }) {
  const { dictationLanguage, onDictationLanguageChange } = useDictationContext()
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [inputText, setInputText] = useState('')
  const [attachedFiles, setAttachedFiles] = useState([])
  const [isSending, setIsSending] = useState(false)
  const [resolvingId, setResolvingId] = useState(null)
  const [error, setError] = useState(null)
  const [isCameraOpen, setIsCameraOpen] = useState(false)
  const messagesEndRef = useRef(null)
  const fileInputRef = useRef(null)
  const documentInputRef = useRef(null)
  const { position, handlePointerDown, hasDraggedRef } = useDraggableTogglePosition(
    CHANGES_CHAT_TOGGLE_POSITION_STORAGE_KEY,
    () => ({ x: window.innerWidth - 80, y: window.innerHeight - 80 })
  )

  function handleToggleClick() {
    if (hasDraggedRef.current) return
    setIsOpen((v) => !v)
  }

  useEffect(() => {
    if (!conceptId) return
    let cancelled = false
    fetch(`${BACKEND_URL}/api/agent-chat/${conceptId}/${stageKey}/history`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setMessages(data.messages ?? [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [conceptId, stageKey, BACKEND_URL])

  useEffect(() => {
    if (isOpen) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, isOpen, isSending])

  function handleFileSelected(event) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length > 0) setAttachedFiles((prev) => [...prev, ...files])
  }

  function handleRemoveAttachedFileClick(index) {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index))
  }

  async function handleSend() {
    if (isSending || (!inputText.trim() && attachedFiles.length === 0)) return
    setIsSending(true)
    setError(null)

    const formData = new FormData()
    formData.append('message', inputText.trim())
    attachedFiles.forEach((file) => formData.append('attachments', file))
    setInputText('')
    setAttachedFiles([])

    try {
      const response = await fetch(`${BACKEND_URL}/api/agent-chat/${conceptId}/${stageKey}/message`, {
        method: 'POST',
        body: formData,
      })
      const data = await response.json()
      if (!response.ok) {
        setError(data.error || t.genericError)
        setIsSending(false)
        return
      }
      setMessages((prev) => [...prev, data.userMessage, data.assistantMessage])
    } catch {
      setError(t.genericError)
    }

    setIsSending(false)
  }

  async function handleResolveAction(messageId, decision) {
    setResolvingId(messageId)
    setError(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/agent-chat/${conceptId}/${stageKey}/resolve-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, decision }),
      })
      const data = await response.json()
      if (!response.ok) {
        setError(data.error || t.genericError)
        setResolvingId(null)
        return
      }
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, resolved: decision, resolvedScheduleSummary: data.scheduleSummary ?? null } : m))
      )
      if (data.schedule) onScheduleUpdated?.(data.schedule)
      if (data.castMember) onCastMemberUpdated?.(data.castMember)
      if (data.breakdown) onBreakdownUpdated?.(data.breakdown)
    } catch {
      setError(t.genericError)
    }

    setResolvingId(null)
  }

  return (
    <>
      <button
        className="changes-chat-toggle"
        style={{ left: position.x, top: position.y }}
        onPointerDown={handlePointerDown}
        onClick={handleToggleClick}
        title={t.changesChatToggleLabel}
      >
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
          {messages.length === 0 && (
            <div className="agent-chat-greeting">
              <p className="agent-chat-greeting-hi">{currentUserName ? `${t.agentChatGreetingHi} ${currentUserName}` : t.agentChatGreetingHi}</p>
              <p className="agent-chat-greeting-prompt">{t.agentChatGreetingPrompt}</p>
              <div className="agent-chat-suggestions">
                {(stageKey === 'schedule'
                  ? [t.scheduleSuggestion1, t.scheduleSuggestion2, t.scheduleSuggestion3]
                  : [t.breakdownSuggestion1, t.breakdownSuggestion2, t.breakdownSuggestion3]
                ).map((suggestion) => (
                  <button key={suggestion} className="agent-chat-suggestion-chip" onClick={() => setInputText(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={m.role === 'user' ? 'changes-chat-bubble user' : 'changes-chat-bubble system'}>
              {m.attachment_photo_urls?.length > 0 && (
                <div className="changes-chat-attachment-thumbs">
                  {m.attachment_photo_urls.map((url, i) => (
                    <img key={i} src={url} alt="" className="changes-chat-attachment-thumb" />
                  ))}
                </div>
              )}
              <div>{m.content}</div>
              {m.proposed_action?.type === 'regenerate_schedule' && m.proposed_action.affectedScenes?.length > 0 && !m.resolved && (
                <div className="changes-chat-scene-preview">
                  <p className="sidebar-section-note">
                    {m.proposed_action.targetDayNumber > 0
                      ? `${t.movingScenesToDayLabel} ${m.proposed_action.targetDayNumber}:`
                      : t.affectedScenesHeading}
                  </p>
                  <table className="changes-chat-scene-table">
                    <thead>
                      <tr>
                        <th>{t.sceneLabel}</th>
                        <th>{t.intExtLabel}</th>
                        <th>{t.locationLabel}</th>
                        <th>{t.descriptionLabel}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.proposed_action.affectedScenes.map((s, i) => (
                        <tr key={i}>
                          <td>{typeof s.episodeIndex === 'number' ? `Ep${s.episodeIndex + 1} ` : ''}Sc{s.sceneNumber}</td>
                          <td>{s.intExt}</td>
                          <td>{s.location}</td>
                          <td>{s.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {m.proposed_action && m.proposed_action.type !== 'none' && !m.resolved && (
                <div className="skip-ahead-controls">
                  <button
                    className="choose-button"
                    onClick={() => handleResolveAction(m.id, 'applied')}
                    disabled={resolvingId === m.id}
                  >
                    {resolvingId === m.id ? t.applyingLabel : t.confirmApplyButton}
                  </button>
                  <button
                    className="cancel-button"
                    onClick={() => handleResolveAction(m.id, 'cancelled')}
                    disabled={resolvingId === m.id}
                  >
                    {t.cancelEditButton}
                  </button>
                </div>
              )}
              {m.resolved === 'applied' && (
                <p className="changes-chat-resolved-note">
                  {m.resolvedScheduleSummary ? (
                    <>
                      {t.changesChatAppliedMessage}
                      <br />
                      <span style={{ whiteSpace: 'pre-line' }}>{m.resolvedScheduleSummary}</span>
                    </>
                  ) : (
                    t.changesChatAppliedMessage
                  )}
                </p>
              )}
              {m.resolved === 'cancelled' && <p className="changes-chat-resolved-note">{t.agentChatCancelledNote}</p>}
            </div>
          ))}
          {isSending && (
            <div className="changes-chat-bubble system changes-chat-progress">
              <span className="changes-chat-dot" />
              <span className="changes-chat-dot" />
              <span className="changes-chat-dot" />
            </div>
          )}
          {error && <div className="changes-chat-bubble system">{`${t.changesChatErrorMessage} ${error}`}</div>}
          <div ref={messagesEndRef} />
        </div>
        {attachedFiles.length > 0 && (
          <div className="changes-chat-attachment-preview-list">
            <p className="agent-chat-what-is-this-prompt">{t.whatIsThisPrompt}</p>
            <div className="changes-chat-attachment-chips">
              {attachedFiles.map((file, i) => (
                <div className="changes-chat-attachment-chip" key={i}>
                  {/^image\//.test(file.type) ? (
                    <img src={URL.createObjectURL(file)} alt="" className="changes-chat-attachment-chip-thumb" />
                  ) : (
                    <span className="changes-chat-attachment-chip-icon">{ICONS.upload}</span>
                  )}
                  <span className="changes-chat-attachment-chip-name">{file.name}</span>
                  <button onClick={() => handleRemoveAttachedFileClick(i)} type="button" title={t.removeCostumeSetButton}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="changes-chat-input-row">
          <button
            className="changes-chat-attach"
            onClick={() => fileInputRef.current?.click()}
            title={t.agentChatAttachPhotoLabel}
            disabled={isSending}
            type="button"
          >
            {ICONS.upload}
          </button>
          <button
            className="changes-chat-attach"
            onClick={() => setIsCameraOpen(true)}
            title={t.useCameraLabel}
            disabled={isSending}
            type="button"
          >
            {ICONS.camera}
          </button>
          <button
            className="changes-chat-attach"
            onClick={() => documentInputRef.current?.click()}
            title={t.attachDocumentLabel}
            disabled={isSending}
            type="button"
          >
            {ICONS.document}
          </button>
          {/* Mobile browsers reliably show ONLY the photo picker when
              image/* is mixed into the same accept list as document
              extensions — so photos and documents get their own separate
              inputs instead of one combined one. */}
          <input
            type="file"
            accept="image/*"
            multiple
            ref={fileInputRef}
            onChange={handleFileSelected}
            style={{ display: 'none' }}
          />
          <input
            type="file"
            accept="application/pdf,.pdf,application/msword,.doc,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx"
            multiple
            ref={documentInputRef}
            onChange={handleFileSelected}
            style={{ display: 'none' }}
          />
          <input
            type="text"
            className="changes-chat-input"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder={attachedFiles.length > 0 ? t.describeAttachmentPlaceholder : t.agentChatInputPlaceholder}
            disabled={isSending}
          />
          <MicButton
            t={t}
            dictationLanguage={dictationLanguage}
            onDictationLanguageChange={onDictationLanguageChange}
            wrapClassName="changes-chat-mic-wrap"
            className="changes-chat-mic"
            title={t.micButtonTitle}
            listeningTitle={t.micButtonListeningTitle}
            onResult={(text) => setInputText((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))}
          />
          <button className="changes-chat-send" onClick={handleSend} disabled={isSending || (!inputText.trim() && attachedFiles.length === 0)}>
            {isSending ? '…' : '↵'}
          </button>
        </div>
      </div>
      {isCameraOpen && (
        <CameraCaptureModal
          t={t}
          multiple
          onCapture={(files) => {
            setAttachedFiles((prev) => [...prev, ...files])
            setIsCameraOpen(false)
          }}
          onClose={() => setIsCameraOpen(false)}
        />
      )}
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
  const [isCameraOpen, setIsCameraOpen] = useState(false)
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
          : language === 'hi'
            ? `नमस्ते ${member.name}! "${linkKey}"${projectTitle ? ` (${projectTitle})` : ''} किरदार के लिए आपके दृश्य यहाँ हैं। कृपया इन्हें देखें और तैयार होने पर एक सेल्फ-टेप ऑडिशन भेजें:\n${data.url}`
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
          <MicInput
            placeholder={category === 'artist' ? t.castingActorNamePlaceholder : t.locationConfirmedNamePlaceholder}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {category === 'artist' && (
            <input type="tel" placeholder={t.crewContactLabel} value={contactNumber} onChange={(e) => setContactNumber(e.target.value)} />
          )}
          <input type="file" accept="image/*" ref={fileInputRef} onChange={(e) => setPhotoFile(e.target.files[0] ?? null)} />
          <button type="button" className="camera-trigger-button" onClick={() => setIsCameraOpen(true)} title={t.useCameraLabel}>
            {ICONS.camera}
          </button>
          {photoFile && <span className="photo-file-selected-note">{photoFile.name}</span>}
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
      {isCameraOpen && (
        <CameraCaptureModal
          t={t}
          onCapture={(file) => {
            setPhotoFile(file)
            setIsCameraOpen(false)
          }}
          onClose={() => setIsCameraOpen(false)}
        />
      )}

      {category === 'artist' && (
        <DownloadChoiceButton
          t={t}
          label={t.downloadAuditionSidesButton}
          className="breakdown-pdf-link audition-sides-link"
          title={t.auditionSidesHint}
          pdfUrl={`${BACKEND_URL}/api/scene-lists/${sceneListId}/character-script/export?character=${encodeURIComponent(linkKey)}&lang=${language}`}
          excelUrl={`${BACKEND_URL}/api/scene-lists/${sceneListId}/character-script/export-excel?character=${encodeURIComponent(linkKey)}&lang=${language}`}
        />
      )}

      {isPickerOpen && (
        <div className="contact-picker">
          <MicInput
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

// Mirrors the backend's AI_MOVIE_STAGE_ORDER — 'story' is always
// pre-approved by the time the review chain matters, so the UI only ever
// actively generates/reviews the other five.
const AI_MOVIE_STAGE_ORDER = ['story', 'synopsis', 'characterArc', 'threeAct', 'plot', 'screenplay']
const AI_MOVIE_FORWARD_STAGES = ['synopsis', 'characterArc', 'threeAct', 'plot', 'screenplay']

// Walks the chain in order and returns the first stage that still needs
// attention: 'generate' (no content yet) or 'review' (pending approval).
// null once every stage is approved.
function getAiMovieCurrentStage(stageStatus) {
  for (const key of AI_MOVIE_STAGE_ORDER) {
    const s = stageStatus[key]
    if (!s) return { key, mode: 'generate' }
    if (s.status === 'pending') return { key, mode: 'review' }
  }
  return null
}

function App() {
  const importFileInputRef = useRef(null)
  const screenplayFileInputRef = useRef(null)
  const reimportScreenplayFileInputRef = useRef(null)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [isClapboardOpen, setIsClapboardOpen] = useState(false)
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
  const [clapboardBannerUrl, setClapboardBannerUrl] = useState(null)
  const [isGeneratingPitchDeck, setIsGeneratingPitchDeck] = useState(false)

  const [pendingStoryline, setPendingStoryline] = useState(null)
  const [regenerateFeedback, setRegenerateFeedback] = useState('')
  const [reviseFeedback, setReviseFeedback] = useState('')
  const [formatType, setFormatType] = useState('film')
  const [episodeCount, setEpisodeCount] = useState(10)
  const [episodeMinutes, setEpisodeMinutes] = useState(10)
  const [runtimeMinutes, setRuntimeMinutes] = useState(120)
  const [errorMessage, setErrorMessage] = useState(null)
  const [toastMessage, setToastMessage] = useState(null)

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
  const [dialogueLanguageByKey, setDialogueLanguageByKey] = useState({})

  const [scriptBreakdown, setScriptBreakdown] = useState(null)
  const [isGeneratingBreakdown, setIsGeneratingBreakdown] = useState(false)
  const breakdownPollCancelRef = useRef(false)
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
  const [isClassifyingCastCategories, setIsClassifyingCastCategories] = useState(false)
  const [isClassifyingEpisodeNumbers, setIsClassifyingEpisodeNumbers] = useState(false)
  const [generatingCostumeRecommendationFor, setGeneratingCostumeRecommendationFor] = useState(null)
  const [approvingCostumeRecommendationFor, setApprovingCostumeRecommendationFor] = useState(null)
  const [editingCostumeSetsFor, setEditingCostumeSetsFor] = useState(null)
  const [costumeSetsDraft, setCostumeSetsDraft] = useState([])
  const [isSavingCostumeSets, setIsSavingCostumeSets] = useState(false)
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

  // Asked once right after login. null = not answered yet (shows the
  // picker). 'movie' = today's existing platform, unchanged. 'ai' = the
  // AI Movie pipeline's own separate UI, built out step by step on later
  // instruction. Not persisted on purpose: a page reload resets this to
  // null, so the picker is always reachable again.
  const [appMode, setAppMode] = useState(null)

  // AI Movie pipeline's first piece: paste anything, one agent identifies
  // which stage of development it represents. Nothing past that is wired
  // up yet — no other sidebar item here does anything.
  const [aiMovieAnalyzeInput, setAiMovieAnalyzeInput] = useState('')
  const [aiMovieAnalyzeStage, setAiMovieAnalyzeStage] = useState(null)
  const [isAnalyzingAiMovie, setIsAnalyzingAiMovie] = useState(false)
  const [aiMovieAnalyzeError, setAiMovieAnalyzeError] = useState(null)

  // Second piece: "Proceed" works backward from the detected stage and
  // invents whichever earlier layers are missing, never touching the
  // pasted material itself.
  const [aiMovieBackfillResult, setAiMovieBackfillResult] = useState(null)
  const [isBackfillingAiMovie, setIsBackfillingAiMovie] = useState(false)
  const [aiMovieBackfillError, setAiMovieBackfillError] = useState(null)
  const [aiMovieBackfillNote, setAiMovieBackfillNote] = useState(null)
  // The silent asset-extraction agent's output (characters/properties/
  // environments) — saved alongside the project but never rendered here.
  const [aiMovieAssets, setAiMovieAssets] = useState(null)
  const [isSavingAiMovieInterval, setIsSavingAiMovieInterval] = useState(false)
  const [isWritingAiMovieSongSheet, setIsWritingAiMovieSongSheet] = useState(false)
  const [isRunningAiMovieScriptDoctor, setIsRunningAiMovieScriptDoctor] = useState(false)
  // A whole-beat Script Doctor fix, pre-filled and waiting for the user's
  // own Submit (rewriting a whole beat replaces its scenes and dialogue).
  const [aiMovieDoctorBeatFixText, setAiMovieDoctorBeatFixText] = useState(null)

  // Persistence: every AI Movie project is saved to its own database row as
  // you go. null = not saved yet (a fresh, un-analyzed paste).
  const [aiMovieProjectId, setAiMovieProjectId] = useState(null)
  const [aiMovieProjectTitle, setAiMovieProjectTitle] = useState(null)
  const [aiMovieView, setAiMovieView] = useState('editor') // 'editor' | 'allProjects'
  const [aiMovieProjectList, setAiMovieProjectList] = useState([])
  const [isLoadingAiMovieProjects, setIsLoadingAiMovieProjects] = useState(false)
  const [isSeedingAkhadaProject, setIsSeedingAkhadaProject] = useState(false)
  const [isFillingAkhadaStages, setIsFillingAkhadaStages] = useState(false)
  const [isFillingAkhadaBeatDurations, setIsFillingAkhadaBeatDurations] = useState(false)
  const [aiMovieFillBeatDurationsNote, setAiMovieFillBeatDurationsNote] = useState(null)
  const [aiMovieLanguage, setAiMovieLanguage] = useState('hi')
  const [aiMovieExpandedStages, setAiMovieExpandedStages] = useState({})
  const [isGeneratingAiMovieScreenplayBeat, setIsGeneratingAiMovieScreenplayBeat] = useState(false)
  const [isApprovingAiMovieScreenplayBeat, setIsApprovingAiMovieScreenplayBeat] = useState(false)
  const [aiMovieScreenplayBeatFeedbackText, setAiMovieScreenplayBeatFeedbackText] = useState('')
  const [showAiMovieScreenplayBeatFeedbackForm, setShowAiMovieScreenplayBeatFeedbackForm] = useState(false)
  const [aiMovieScreenplayViewIndex, setAiMovieScreenplayViewIndex] = useState(0)
  const [isRevisingAiMovieScreenplayScene, setIsRevisingAiMovieScreenplayScene] = useState(false)
  const [aiMovieRevisingSceneIndex, setAiMovieRevisingSceneIndex] = useState(null)
  const [aiMovieReviseSceneText, setAiMovieReviseSceneText] = useState('')
  const [isWritingAiMovieDialogue, setIsWritingAiMovieDialogue] = useState(false)
  const [aiMovieDialogueSceneIndex, setAiMovieDialogueSceneIndex] = useState(null)
  const [aiMovieDialogueInstructionText, setAiMovieDialogueInstructionText] = useState('')
  // Write Dialogue's error is shown right under that scene's own button
  // ({ key: "beat-scene", message }) -- it used to go to the bottom of the
  // whole Screenplay section, so a failed request looked like "nothing
  // happens".
  const [aiMovieDialogueError, setAiMovieDialogueError] = useState(null)
  // Screenplay page colour -- white paper or black, like Final Draft's two
  // backdrops (the user's call). Remembered in this browser only.
  const [scriptTheme, setScriptTheme] = useState(() => {
    try {
      return localStorage.getItem('scriptTheme') === 'dark' ? 'dark' : 'light'
    } catch {
      return 'light'
    }
  })
  // Which scene the tools panel is showing (step 2 of the redesign), and
  // which way the page last turned -- the page slides in from that side.
  const [aiMovieSelectedSceneIndex, setAiMovieSelectedSceneIndex] = useState(0)
  // Which stage fills the centre screen -- the left menu's Story /
  // Synopsis / ... / Screenplay items work as switches (the user's
  // request) instead of one long column of every stage. null = follow the
  // stage being worked on right now.
  const [aiMovieFocusedStage, setAiMovieFocusedStage] = useState(null)
  // Typing straight into the script (user request). While a scene is being
  // edited, this holds its blocks in the language being read, as plain
  // strings; Submit sends them to the script editor, which fixes grammar
  // and language and writes the other language to match.
  const [aiMovieEditingScene, setAiMovieEditingScene] = useState(null)
  const [isSubmittingAiMovieSceneEdit, setIsSubmittingAiMovieSceneEdit] = useState(false)
  const [aiMovieSceneEditError, setAiMovieSceneEditError] = useState(null)
  const [aiMovieSceneEditFixes, setAiMovieSceneEditFixes] = useState(null)
  const [aiMovieBeatTurnDirection, setAiMovieBeatTurnDirection] = useState('open')
  function selectAiMovieScene(sceneIndex, scrollToIt) {
    setAiMovieSelectedSceneIndex(sceneIndex)
    if (scrollToIt) {
      document.getElementById(`script-scene-${sceneIndex}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }
  useEffect(() => {
    setAiMovieSelectedSceneIndex(0)
    setAiMovieEditingScene(null)
  }, [aiMovieScreenplayViewIndex])

  // Every click answers with a soft ripple from the point pressed (step 4
  // of the redesign) -- one listener for the whole app, so every button
  // gets it without each one needing its own code. Skipped for people
  // whose system asks for less motion.
  useEffect(() => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) return undefined
    function handlePointerDown(event) {
      const button = event.target.closest?.('button')
      if (!button || button.disabled) return
      if (getComputedStyle(button).position === 'static') button.classList.add('has-ripple')
      else if (!button.classList.contains('has-ripple')) button.style.overflow = 'hidden'
      const rect = button.getBoundingClientRect()
      const size = Math.max(rect.width, rect.height) * 2
      const ripple = document.createElement('span')
      ripple.className = 'click-ripple'
      ripple.style.width = `${size}px`
      ripple.style.height = `${size}px`
      ripple.style.left = `${event.clientX - rect.left - size / 2}px`
      ripple.style.top = `${event.clientY - rect.top - size / 2}px`
      button.appendChild(ripple)
      ripple.addEventListener('animationend', () => ripple.remove())
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [])
  function changeScriptTheme(mode) {
    setScriptTheme(mode)
    try {
      localStorage.setItem('scriptTheme', mode)
    } catch {
      // Private window or blocked storage: the switch still works for this visit.
    }
  }
  // Beat-wide narration: which beat's box is open, its text, progress
  // ({ scene, total }) while it runs, and any error.
  const [aiMovieNarrationBeatIndex, setAiMovieNarrationBeatIndex] = useState(null)
  const [aiMovieNarrationText, setAiMovieNarrationText] = useState('')
  const [aiMovieNarrationProgress, setAiMovieNarrationProgress] = useState(null)
  const [aiMovieNarrationError, setAiMovieNarrationError] = useState(null)
  const [isExportingAiMovieProject, setIsExportingAiMovieProject] = useState(false)
  const aiMovieImportFileInputRef = useRef(null)

  // Reference material: source content the user hands the agents directly
  // (a real book, or their own character/property/art details) so the
  // backfill and asset-extraction agents stay faithful to it instead of
  // inventing their own. No category picker — a silent agent reads and
  // sorts each piece itself.
  const [aiMovieReferenceFileList, setAiMovieReferenceFileList] = useState([])
  const [aiMovieReferenceText, setAiMovieReferenceText] = useState('')
  const [isAddingAiMovieReferenceText, setIsAddingAiMovieReferenceText] = useState(false)
  const [isUploadingAiMovieReferenceFile, setIsUploadingAiMovieReferenceFile] = useState(false)
  const [aiMovieReferenceError, setAiMovieReferenceError] = useState(null)
  const aiMovieReferenceFileInputRef = useRef(null)
  // Originates a story straight from Reference Material alone, for when
  // nothing's been pasted into the main box yet.
  const [isGeneratingAiMovieFromReference, setIsGeneratingAiMovieFromReference] = useState(false)

  // The step-by-step review chain: Story is always pre-approved by the
  // time this matters (via paste+Proceed or Generate-from-Reference);
  // Synopsis/Plot/Character Arc/Screenplay each generate one at a time,
  // only once the layer before them is approved. Shape matches the
  // backend: { story: {status, feedback}, synopsis: {...}, ... }.
  const [aiMovieStageStatus, setAiMovieStageStatus] = useState({})
  const [isGeneratingAiMovieStage, setIsGeneratingAiMovieStage] = useState(false)
  const [isApprovingAiMovieStage, setIsApprovingAiMovieStage] = useState(false)
  const [showAiMovieStageFeedbackForm, setShowAiMovieStageFeedbackForm] = useState(false)
  const [aiMovieStageFeedbackText, setAiMovieStageFeedbackText] = useState('')
  const [aiMovieStageError, setAiMovieStageError] = useState(null)

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

  const [editingSceneKey, setEditingSceneKey] = useState(null)
  const [editSceneCostume, setEditSceneCostume] = useState('')
  const [editSceneProperties, setEditSceneProperties] = useState('')
  const [editSceneAdRemark, setEditSceneAdRemark] = useState('')
  const [isSavingSceneEdit, setIsSavingSceneEdit] = useState(false)

  function handleStartSceneEditClick(ref) {
    setEditingSceneKey(`${ref.episodeIndex ?? ''}-${ref.sceneIndex}`)
    setEditSceneCostume(ref.costume || '')
    setEditSceneProperties(ref.properties || '')
    setEditSceneAdRemark(ref.adRemark || '')
  }

  async function handleSaveSceneEditClick(ref) {
    setIsSavingSceneEdit(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/shoot-schedule/${shootSchedule.id}/edit-scene`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          episodeIndex: typeof ref.episodeIndex === 'number' ? ref.episodeIndex : null,
          sceneIndex: ref.sceneIndex,
          costume: editSceneCostume,
          properties: editSceneProperties,
          adRemark: editSceneAdRemark,
        }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsSavingSceneEdit(false)
        return
      }

      setShootSchedule(data)
      if (data.breakdown) setScriptBreakdown(data.breakdown)
      setEditingSceneKey(null)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsSavingSceneEdit(false)
  }
  const [shotCompletionNote, setShotCompletionNote] = useState('')
  const [isRecordingShotDay, setIsRecordingShotDay] = useState(false)
  const [dayCompletionReportText, setDayCompletionReportText] = useState('')
  const [isParsingDayCompletion, setIsParsingDayCompletion] = useState(false)
  const [dayCompletionParseResult, setDayCompletionParseResult] = useState(null)
  const [extraSceneReportText, setExtraSceneReportText] = useState('')
  const [extraSceneSelections, setExtraSceneSelections] = useState({})
  const [isPreparingNextDays, setIsPreparingNextDays] = useState(false)

  const [activeAgent, setActiveAgent] = useState('story')
  // Which section the AD last clicked to in the sidebar nav — the chat's
  // own stage follows this instead of defaulting to whichever of
  // schedule/breakdown happens to exist, so a question asked while looking
  // at the Script Breakdown page (e.g. about a costume recommendation)
  // doesn't silently get answered/applied against the Shoot Schedule
  // because a schedule also happens to exist. Null until the AD actually
  // clicks one of those two nav items this session.
  const [chatFocusStage, setChatFocusStage] = useState(null)
  const [openChangesChatSignal, setOpenChangesChatSignal] = useState(0)
  const [clearDraftHistorySignal, setClearDraftHistorySignal] = useState(0)
  const [dictationLanguage, setDictationLanguage] = useState(() => {
    try {
      return localStorage.getItem('filmmaking-app:dictationLanguage') || 'en'
    } catch {
      return 'en'
    }
  })

  function handleDictationLanguageChange(nextLanguage) {
    setDictationLanguage(nextLanguage)
    try {
      localStorage.setItem('filmmaking-app:dictationLanguage', nextLanguage)
    } catch {
      // per-viewer convenience only
    }
  }
  const [projectType, setProjectType] = useState('story')
  const [masterProjectList, setMasterProjectList] = useState([])
  const [isLoadingMasterList, setIsLoadingMasterList] = useState(false)
  const [selectedMasterProjectIds, setSelectedMasterProjectIds] = useState(() => new Set())
  const [isBulkDeletingProjects, setIsBulkDeletingProjects] = useState(false)
  const [importScreenplayText, setImportScreenplayText] = useState('')
  const [isImportingScreenplay, setIsImportingScreenplay] = useState(false)
  const [isImportingScreenplayFile, setIsImportingScreenplayFile] = useState(false)
  const [showReimportForm, setShowReimportForm] = useState(false)
  const [reimportScreenplayText, setReimportScreenplayText] = useState('')
  const [isReimportingScreenplay, setIsReimportingScreenplay] = useState(false)
  const [reimportResult, setReimportResult] = useState(null)

  const t = LABELS[language] ?? LABELS.en
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
    if (formatType === 'series' || formatType === 'vertical') {
      return { type: formatType, episodeCount: Number(episodeCount), episodeMinutes: Number(episodeMinutes) }
    }
    return { type: 'film', runtimeMinutes: Number(runtimeMinutes) }
  }

  async function loadStructureHistory(pitchDeckId) {
    const response = await fetch(`${BACKEND_URL}/api/three-act-structure/history?pitchDeckId=${pitchDeckId}`)
    const data = await response.json()
    setStructureHistory(data)
  }

  async function fetchScreenplayScenesMap(sceneListId) {
    const response = await fetch(`${BACKEND_URL}/api/screenplay/scenes?sceneListId=${sceneListId}`)
    const data = await response.json()
    const map = {}
    data.forEach((scene) => {
      map[screenplayKey(scene.episodeIndex, scene.sceneIndex)] = scene
    })
    return map
  }

  async function loadScreenplayScenes(sceneListId) {
    setScreenplayScenesByKey(await fetchScreenplayScenesMap(sceneListId))
  }

  // After a scene is added or deleted every later scene has a new position,
  // so the scene list and the written scenes are swapped in together (never
  // a moment where a heading sits over the wrong scene's script).
  async function applySceneListChange(content) {
    const map = await fetchScreenplayScenesMap(sceneList.id)
    setSceneList((prev) => ({ ...prev, ...content }))
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
    // A 401/403 response body is {error: "..."} — not an array. Setting
    // that directly into projectHistory crashed the whole app the next
    // time anything did projectHistory.filter(...), with no error boundary
    // to catch it. A session that expired mid-use (or any other auth hiccup)
    // should just leave the existing list showing, not blank the app.
    if (!response.ok || !Array.isArray(data)) return
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

  // Unlike handleRenameProjectClick (which only ever renames whichever
  // project is currently loaded, via conceptId), this renames ANY project
  // listed here directly — no need to open it first.
  async function handleRenameMasterProjectClick(project) {
    const nextTitle = window.prompt(t.renameProjectPrompt, project.title)
    if (nextTitle === null) return

    const trimmed = nextTitle.trim()
    const response = await fetch(`${BACKEND_URL}/api/concepts/${project.id}/title`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: trimmed || null }),
    })
    if (!response.ok) return

    if (project.id === conceptId) {
      const data = await response.json()
      setProjectTitle(data.title)
    }
    loadMasterProjectList()
    loadProjectList()
  }

  async function handleDeleteMasterProjectClick(project) {
    if (!window.confirm(t.deleteProjectConfirm)) return

    await fetch(`${BACKEND_URL}/api/concepts/${project.id}`, { method: 'DELETE' })

    if (project.id === conceptId) {
      handleNewIdeaClick()
    }
    loadMasterProjectList()
    loadProjectList()
  }

  function toggleMasterProjectSelected(projectId) {
    setSelectedMasterProjectIds((current) => {
      const next = new Set(current)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }

  async function handleBulkDeleteMasterProjectsClick() {
    const ids = [...selectedMasterProjectIds]
    if (ids.length === 0) return
    if (!window.confirm(t.bulkDeleteProjectsConfirm(ids.length))) return

    setIsBulkDeletingProjects(true)
    try {
      await Promise.all(ids.map((id) => fetch(`${BACKEND_URL}/api/concepts/${id}`, { method: 'DELETE' })))
    } finally {
      if (ids.includes(conceptId)) {
        handleNewIdeaClick()
      }
      setSelectedMasterProjectIds(new Set())
      setIsBulkDeletingProjects(false)
      loadMasterProjectList()
      loadProjectList()
    }
  }

  // A breakdown analyzed before cast tiers/episode numbers existed gets
  // fixed in the background (see triggerScriptBreakdownAutoBackfill on the
  // backend) the moment its project is opened — this polls quietly until
  // that finishes, so the fix actually becomes visible without the user
  // needing to know to refresh or click anything themselves.
  async function pollForAutoBackfill(id) {
    const pollIntervalMs = 10000
    const maxAttempts = 60 // 10 minutes

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))

      try {
        const response = await fetch(`${BACKEND_URL}/api/concepts/${id}/full`)
        if (!response.ok) continue
        const data = await response.json()
        const status = data.scriptBreakdown?.autoBackfillStatus
        if (status === 'in_progress' || status === 'retrying_after_failure') continue

        setScriptBreakdown(data.scriptBreakdown)
        return
      } catch {
        // a single missed poll isn't fatal — just try again next tick
      }
    }
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
    setClapboardBannerUrl(data.clapboardBannerUrl ?? null)

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
    if (data.scriptBreakdown?.autoBackfillStatus === 'in_progress' || data.scriptBreakdown?.autoBackfillStatus === 'retrying_after_failure') {
      pollForAutoBackfill(id)
    }

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

  async function handleAnalyzeAiMovieClick() {
    setIsAnalyzingAiMovie(true)
    setAiMovieAnalyzeError(null)
    setAiMovieAnalyzeStage(null)
    setAiMovieBackfillResult(null)
    setAiMovieBackfillError(null)
    setAiMovieBackfillNote(null)
    setAiMovieAssets(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/analyze-stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pastedText: aiMovieAnalyzeInput, projectId: aiMovieProjectId }),
      })
      const data = await response.json()

      if (!response.ok) {
        setAiMovieAnalyzeError(data.error || t.genericError)
      } else {
        setAiMovieAnalyzeStage(data.stage)
        setAiMovieProjectId(data.projectId)
        localStorage.setItem(CURRENT_AI_MOVIE_PROJECT_STORAGE_KEY, String(data.projectId))
      }
    } catch {
      setAiMovieAnalyzeError(t.genericError)
    }

    setIsAnalyzingAiMovie(false)
  }

  async function handleAiMovieProceedClick() {
    setAiMovieBackfillError(null)
    setAiMovieBackfillNote(null)
    setAiMovieBackfillResult(null)
    setAiMovieAssets(null)

    if (aiMovieAnalyzeStage === 'other') {
      setAiMovieBackfillNote(t.aiMovieBackfillNoteOther)
      return
    }
    if (aiMovieAnalyzeStage === 'concept' || aiMovieAnalyzeStage === 'story') {
      setAiMovieBackfillNote(t.aiMovieBackfillNoteEarliest)
      return
    }

    setIsBackfillingAiMovie(true)

    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/backfill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pastedText: aiMovieAnalyzeInput, stage: aiMovieAnalyzeStage, projectId: aiMovieProjectId }),
      })
      const data = await response.json()

      if (!response.ok) {
        setAiMovieBackfillError(data.error || t.genericError)
      } else {
        setAiMovieBackfillResult(data.backfill)
        // Saved silently alongside the project — never rendered here.
        setAiMovieAssets(data.assets)
        setAiMovieStageStatus(data.stageStatus ?? {})
        if (data.backfill?.story?.title) setAiMovieProjectTitle(data.backfill.story.title.en)
      }
    } catch {
      setAiMovieBackfillError(t.genericError)
    }

    setIsBackfillingAiMovie(false)
  }

  function resetAiMovieEditorState() {
    setAiMovieAnalyzeInput('')
    setAiMovieAnalyzeStage(null)
    setAiMovieAnalyzeError(null)
    setAiMovieBackfillResult(null)
    setAiMovieBackfillError(null)
    setAiMovieBackfillNote(null)
    setAiMovieAssets(null)
    setAiMovieProjectId(null)
    localStorage.removeItem(CURRENT_AI_MOVIE_PROJECT_STORAGE_KEY)
    setAiMovieProjectTitle(null)
    setAiMovieReferenceFileList([])
    setAiMovieReferenceText('')
    setAiMovieReferenceError(null)
    setAiMovieStageStatus({})
    setShowAiMovieStageFeedbackForm(false)
    setAiMovieStageFeedbackText('')
    setAiMovieStageError(null)
    setAiMovieExpandedStages({})
    setShowAiMovieScreenplayBeatFeedbackForm(false)
    setAiMovieScreenplayBeatFeedbackText('')
    setAiMovieScreenplayViewIndex(0)
  }

  function handleAiMovieNewIdeaClick() {
    resetAiMovieEditorState()
    setAiMovieView('editor')
  }

  async function loadAiMovieProjectList() {
    setIsLoadingAiMovieProjects(true)
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/projects`)
      if (response.ok) setAiMovieProjectList(await response.json())
    } catch {
      // The list staying empty/stale here is a minor inconvenience, not
      // worth a whole error banner over.
    }
    setIsLoadingAiMovieProjects(false)
  }

  async function handleDeleteAiMovieProjectClick(project) {
    if (!window.confirm(t.aiMovieDeleteProjectConfirm)) return

    await fetch(`${BACKEND_URL}/api/ai-movie/projects/${project.id}`, { method: 'DELETE' })

    if (project.id === aiMovieProjectId) {
      resetAiMovieEditorState()
    }
    loadAiMovieProjectList()
  }

  async function handleSeedAkhadaProjectClick() {
    setIsSeedingAkhadaProject(true)
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/projects/seed-akhada`, { method: 'POST' })
      const data = await response.json()
      if (response.ok) {
        await loadAiMovieProject(data.projectId)
      }
    } catch {
      // Same non-fatal pattern as the rest of this list — the button stays
      // clickable to try again rather than a whole error banner.
    }
    setIsSeedingAkhadaProject(false)
  }

  function handleAiMovieAllProjectsClick() {
    setAiMovieView('allProjects')
    loadAiMovieProjectList()
  }

  function handleAiMovieReferenceViewClick() {
    // Toggle: click again to go straight back to the project you were on,
    // instead of dead-ending into a screen only reachable back out through
    // All Projects.
    setAiMovieView((prev) => (prev === 'reference' ? 'editor' : 'reference'))
  }

  // Picking "AI Movie" off the Movie/AI Movie picker used to always land on
  // a blank editor or the All Projects list, even if you'd been mid-way
  // through a real project last time -- resume it directly instead, same
  // as the Movie side already does for its own last-loaded project.
  function handleChooseAiMovieMode() {
    setAppMode('ai')
    const savedProjectId = localStorage.getItem(CURRENT_AI_MOVIE_PROJECT_STORAGE_KEY)
    if (savedProjectId) {
      loadAiMovieProject(savedProjectId)
    }
  }

  async function loadAiMovieProject(id) {
    setAiMovieAnalyzeError(null)
    setAiMovieFocusedStage(null)
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/projects/${id}`)
      const data = await response.json()

      if (!response.ok) {
        setAiMovieAnalyzeError(data.error || t.genericError)
        // A saved project id that no longer resolves (deleted, or from
        // another environment's data) shouldn't keep silently failing to
        // resume on every future visit -- forget it and fall back to the
        // normal blank editor.
        localStorage.removeItem(CURRENT_AI_MOVIE_PROJECT_STORAGE_KEY)
        return
      }

      setAiMovieAnalyzeInput(data.pastedText)
      setAiMovieAnalyzeStage(data.detectedStage)
      setAiMovieBackfillResult(data.backfill && Object.keys(data.backfill).length > 0 ? data.backfill : null)
      setAiMovieAssets(data.assets)
      setAiMovieProjectId(data.id)
      localStorage.setItem(CURRENT_AI_MOVIE_PROJECT_STORAGE_KEY, String(data.id))
      setAiMovieProjectTitle(data.title)
      setAiMovieBackfillError(null)
      setAiMovieBackfillNote(null)
      setAiMovieStageStatus(data.stageStatus ?? {})
      setShowAiMovieStageFeedbackForm(false)
      setAiMovieStageFeedbackText('')
      setAiMovieStageError(null)
      setAiMovieExpandedStages({})
      setShowAiMovieScreenplayBeatFeedbackForm(false)
      setAiMovieScreenplayBeatFeedbackText('')
      setAiMovieView('editor')
      loadAiMovieReferenceFiles(data.id)

      // Reopening a project mid-screenplay-generation (e.g. after a page
      // reload) resumes polling on its own rather than leaving a stale
      // "generating" beat on screen until the user happens to click
      // something.
      if (data.backfill?.scriptCheck?.status === 'running') pollAiMovieScriptCheck(data.id)
      const screenplayBeats = data.backfill?.screenplayBeats ?? []
      const currentBeat = screenplayBeats.find((b) => b.status !== 'approved')
      const firstUnfinishedIndex = screenplayBeats.findIndex((b) => b.status !== 'approved')
      setAiMovieScreenplayViewIndex(firstUnfinishedIndex === -1 ? 0 : firstUnfinishedIndex)
      if (currentBeat && (currentBeat.status === 'generating' || currentBeat.status === 'not_started')) {
        pollAiMovieScreenplayUntilReady(data.id)
      }
    } catch {
      setAiMovieAnalyzeError(t.genericError)
    }
  }

  async function loadAiMovieReferenceFiles(projectId) {
    if (!projectId) {
      setAiMovieReferenceFileList([])
      return
    }
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/reference-files?projectId=${projectId}`)
      if (response.ok) setAiMovieReferenceFileList(await response.json())
    } catch {
      // Same as the project list — staying stale here isn't worth an error banner.
    }
  }

  async function handleAddAiMovieReferenceTextClick() {
    if (!aiMovieReferenceText.trim()) return

    setIsAddingAiMovieReferenceText(true)
    setAiMovieReferenceError(null)
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/reference-files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: aiMovieProjectId,
          label: aiMovieReferenceText.slice(0, 40),
          content: aiMovieReferenceText,
        }),
      })
      const data = await response.json()

      if (!response.ok) {
        setAiMovieReferenceError(data.error || t.genericError)
      } else {
        if (!aiMovieProjectId) {
          setAiMovieProjectId(data.projectId)
          localStorage.setItem(CURRENT_AI_MOVIE_PROJECT_STORAGE_KEY, String(data.projectId))
        }
        setAiMovieReferenceText('')
        await loadAiMovieReferenceFiles(data.projectId)
      }
    } catch {
      setAiMovieReferenceError(t.genericError)
    }
    setIsAddingAiMovieReferenceText(false)
  }

  async function handleAiMovieReferenceFileSelected(event) {
    const files = Array.from(event.target.files)
    event.target.value = ''
    if (files.length === 0) return

    setIsUploadingAiMovieReferenceFile(true)
    setAiMovieReferenceError(null)
    try {
      const formData = new FormData()
      files.forEach((file) => formData.append('files', file))
      if (aiMovieProjectId) formData.append('projectId', aiMovieProjectId)

      const response = await fetch(`${BACKEND_URL}/api/ai-movie/reference-files/upload`, {
        method: 'POST',
        body: formData,
      })
      const data = await response.json()

      if (!response.ok) {
        setAiMovieReferenceError(data.error || t.genericError)
      } else {
        if (!aiMovieProjectId) {
          setAiMovieProjectId(data.projectId)
          localStorage.setItem(CURRENT_AI_MOVIE_PROJECT_STORAGE_KEY, String(data.projectId))
        }
        if (data.errors?.length > 0) {
          setAiMovieReferenceError(data.errors.map((e) => `${e.filename}: ${e.error}`).join(' · '))
        }
        await loadAiMovieReferenceFiles(data.projectId)
      }
    } catch {
      setAiMovieReferenceError(t.genericError)
    }
    setIsUploadingAiMovieReferenceFile(false)
  }

  async function handleDeleteAiMovieReferenceFileClick(id) {
    try {
      await fetch(`${BACKEND_URL}/api/ai-movie/reference-files/${id}`, { method: 'DELETE' })
      setAiMovieReferenceFileList((list) => list.filter((f) => f.id !== id))
    } catch {
      setAiMovieReferenceError(t.genericError)
    }
  }

  async function handleGenerateAiMovieFromReferenceClick() {
    if (!aiMovieProjectId) return

    setIsGeneratingAiMovieFromReference(true)
    setAiMovieReferenceError(null)
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/generate-from-reference`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: aiMovieProjectId }),
      })
      const data = await response.json()

      if (!response.ok) {
        setAiMovieReferenceError(data.error || t.genericError)
      } else {
        setAiMovieAnalyzeInput(data.pastedText)
        setAiMovieAnalyzeStage(data.stage)
        setAiMovieAnalyzeError(null)
        setAiMovieBackfillResult(data.backfill)
        setAiMovieBackfillError(null)
        setAiMovieBackfillNote(null)
        setAiMovieAssets(data.assets)
        setAiMovieStageStatus(data.stageStatus ?? {})
        if (data.backfill?.story?.title) setAiMovieProjectTitle(data.backfill.story.title.en)
      }
    } catch {
      setAiMovieReferenceError(t.genericError)
    }
    setIsGeneratingAiMovieFromReference(false)
  }

  // Kicks the fill off, then polls status instead of waiting on one
  // long-lived request — the backend does 5 sequential Gemini calls for
  // this (synopsis, characters, three-act, and 46 beats in two batches),
  // which reliably took long enough to hit a network-level timeout when
  // held open in a single response.
  async function handleFillAkhadaStagesClick() {
    if (!aiMovieProjectId) return
    const projectId = aiMovieProjectId

    setIsFillingAkhadaStages(true)
    setAiMovieStageError(null)
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/projects/${projectId}/fill-akhada-stages`, {
        method: 'POST',
      })
      const data = await response.json()
      if (!response.ok) {
        setAiMovieStageError(data.error || t.genericError)
        setIsFillingAkhadaStages(false)
        return
      }
    } catch {
      setAiMovieStageError(t.genericError)
      setIsFillingAkhadaStages(false)
      return
    }

    const pollFillStatus = async () => {
      try {
        const statusResponse = await fetch(`${BACKEND_URL}/api/ai-movie/projects/${projectId}/fill-akhada-status`)
        const statusData = await statusResponse.json()
        if (statusData.status === 'done') {
          await loadAiMovieProject(projectId)
          setIsFillingAkhadaStages(false)
          return
        }
        if (statusData.status === 'error') {
          setAiMovieStageError(statusData.error || t.genericError)
          setIsFillingAkhadaStages(false)
          return
        }
        setTimeout(pollFillStatus, 4000)
      } catch {
        setAiMovieStageError(t.genericError)
        setIsFillingAkhadaStages(false)
      }
    }
    setTimeout(pollFillStatus, 4000)
  }

  // Purely numeric and instant (no Gemini call) -- a plain synchronous
  // request/response, unlike the multi-Gemini-call fill above.
  async function handleFillAkhadaBeatDurationsClick() {
    if (!aiMovieProjectId) return
    const projectId = aiMovieProjectId

    setIsFillingAkhadaBeatDurations(true)
    setAiMovieStageError(null)
    setAiMovieFillBeatDurationsNote(null)
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/projects/${projectId}/fill-akhada-beat-durations`, {
        method: 'POST',
      })
      const data = await response.json()
      if (!response.ok) {
        setAiMovieStageError(data.error || t.genericError)
      } else {
        await loadAiMovieProject(projectId)
        setAiMovieFillBeatDurationsNote(t.aiMovieFillBeatDurationsResultNote(data.updated, data.total))
      }
    } catch {
      setAiMovieStageError(t.genericError)
    }
    setIsFillingAkhadaBeatDurations(false)
  }

  // Screenplay writes one beat at a time in the background (a 46-beat sheet
  // has to expand into ~120-150 scenes -- far too much for one request to
  // hold open), so its generate call is polled instead of awaited directly.
  // Every other stage is small enough to stay a single synchronous call.
  async function runGenerateAiMovieStage(stageKey, feedback) {
    if (!aiMovieProjectId) return
    const projectId = aiMovieProjectId

    setIsGeneratingAiMovieStage(true)
    setAiMovieStageError(null)
    setAiMovieScreenplayProgress(null)
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/stages/${stageKey}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(feedback ? { projectId, feedback } : { projectId }),
      })
      const data = await response.json()

      if (!response.ok) {
        setAiMovieStageError(data.error || t.genericError)
        setIsGeneratingAiMovieStage(false)
        return
      }

      if (stageKey !== 'screenplay') {
        setAiMovieBackfillResult((prev) => ({ ...(prev ?? {}), [stageKey]: data.content }))
        setAiMovieStageStatus((prev) => ({ ...prev, [stageKey]: { status: 'pending', feedback: feedback ?? null } }))
        setShowAiMovieStageFeedbackForm(false)
        setAiMovieStageFeedbackText('')
        setIsGeneratingAiMovieStage(false)
        return
      }
    } catch {
      setAiMovieStageError(t.genericError)
      setIsGeneratingAiMovieStage(false)
      return
    }

    const pollScreenplayStatus = async () => {
      try {
        const statusResponse = await fetch(`${BACKEND_URL}/api/ai-movie/stages/screenplay/status?projectId=${projectId}`)
        const statusData = await statusResponse.json()
        if (statusData.status === 'done') {
          await loadAiMovieProject(projectId)
          setShowAiMovieStageFeedbackForm(false)
          setAiMovieStageFeedbackText('')
          setAiMovieScreenplayProgress(null)
          setIsGeneratingAiMovieStage(false)
          return
        }
        if (statusData.status === 'error') {
          setAiMovieStageError(statusData.error || t.genericError)
          setAiMovieScreenplayProgress(null)
          setIsGeneratingAiMovieStage(false)
          return
        }
        setAiMovieScreenplayProgress({ completed: statusData.completed ?? 0, total: statusData.total ?? 0 })
        setTimeout(pollScreenplayStatus, 4000)
      } catch {
        setAiMovieStageError(t.genericError)
        setAiMovieScreenplayProgress(null)
        setIsGeneratingAiMovieStage(false)
      }
    }
    setTimeout(pollScreenplayStatus, 4000)
  }

  function handleGenerateAiMovieStageClick(stageKey) {
    runGenerateAiMovieStage(stageKey, null)
  }

  function handleSubmitAiMovieStageFeedbackClick(stageKey) {
    if (!aiMovieStageFeedbackText.trim()) return
    runGenerateAiMovieStage(stageKey, aiMovieStageFeedbackText)
  }

  async function handleApproveAiMovieStageClick(stageKey) {
    if (!aiMovieProjectId) return

    setIsApprovingAiMovieStage(true)
    setAiMovieStageError(null)
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/stages/${stageKey}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: aiMovieProjectId }),
      })
      const data = await response.json()

      if (!response.ok) {
        setAiMovieStageError(data.error || t.genericError)
      } else {
        setAiMovieStageStatus((prev) => ({ ...prev, [stageKey]: { status: 'approved', feedback: null } }))
        if (data.assets) setAiMovieAssets(data.assets)
        // Move on to the next stage, the way the long column used to.
        setAiMovieFocusedStage(null)
      }
    } catch {
      setAiMovieStageError(t.genericError)
    }
    setIsApprovingAiMovieStage(false)
  }

  // Screenplay is generated and reviewed one beat at a time (a running
  // buffer of a few beats stays ready ahead of whichever one the user is
  // currently looking at), so its progress lives entirely in
  // backfill.screenplayBeats rather than one flat stage. Polling just
  // re-fetches the normal project detail until the beat the user needs to
  // see next is actually ready.
  async function pollAiMovieScreenplayUntilReady(projectId) {
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/projects/${projectId}`)
      const data = await response.json()
      if (!response.ok) return

      setAiMovieBackfillResult((prev) => ({ ...(prev ?? {}), screenplayBeats: data.backfill?.screenplayBeats ?? [] }))
      setAiMovieStageStatus(data.stageStatus ?? {})

      const beats = data.backfill?.screenplayBeats ?? []
      const currentIndex = beats.findIndex((b) => b.status !== 'approved')
      const stillWaiting = currentIndex !== -1 && (beats[currentIndex].status === 'generating' || beats[currentIndex].status === 'not_started')
      if (stillWaiting) {
        setTimeout(() => pollAiMovieScreenplayUntilReady(projectId), 4000)
      }
    } catch {
      // A missed poll just tries again on the next click/approve — not
      // worth surfacing as an error banner on its own.
    }
  }

  async function handleGenerateAiMovieScreenplayClick() {
    if (!aiMovieProjectId) return
    const projectId = aiMovieProjectId

    setAiMovieScreenplayViewIndex(0)
    setIsGeneratingAiMovieScreenplayBeat(true)
    setAiMovieStageError(null)
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/stages/screenplay/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      })
      const data = await response.json()
      if (!response.ok) {
        setAiMovieStageError(data.error || t.genericError)
        setIsGeneratingAiMovieScreenplayBeat(false)
        return
      }
    } catch {
      setAiMovieStageError(t.genericError)
      setIsGeneratingAiMovieScreenplayBeat(false)
      return
    }
    await pollAiMovieScreenplayUntilReady(projectId)
    setIsGeneratingAiMovieScreenplayBeat(false)
  }

  async function handleApproveAiMovieScreenplayBeatClick(beatIndex) {
    if (!aiMovieProjectId) return
    const projectId = aiMovieProjectId

    setIsApprovingAiMovieScreenplayBeat(true)
    setAiMovieStageError(null)
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/stages/screenplay/beats/${beatIndex}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      })
      const data = await response.json()
      if (!response.ok) {
        setAiMovieStageError(data.error || t.genericError)
        setIsApprovingAiMovieScreenplayBeat(false)
        return
      }
      setShowAiMovieScreenplayBeatFeedbackForm(false)
      setAiMovieScreenplayBeatFeedbackText('')
      // Slide forward to the next beat -- still just a default position;
      // Prev/Next stay free to move anywhere from here.
      setAiMovieBeatTurnDirection('next')
      setAiMovieScreenplayViewIndex((i) => i + 1)
    } catch {
      setAiMovieStageError(t.genericError)
      setIsApprovingAiMovieScreenplayBeat(false)
      return
    }
    await pollAiMovieScreenplayUntilReady(projectId)
    setIsApprovingAiMovieScreenplayBeat(false)
  }

  async function handleRunAiMovieScriptDoctorClick(beatIndex) {
    if (!aiMovieProjectId) return
    setIsRunningAiMovieScriptDoctor(true)
    setAiMovieDoctorBeatFixText(null)
    setAiMovieStageError(null)
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/stages/screenplay/beats/${beatIndex}/doctor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: aiMovieProjectId }),
      })
      const data = await response.json()
      if (!response.ok) {
        setAiMovieStageError(data.error || t.genericError)
      } else {
        setAiMovieBackfillResult((prev) => {
          const beats = [...(prev?.screenplayBeats ?? [])]
          beats[beatIndex] = { ...(beats[beatIndex] ?? {}), doctorNotes: data.doctorNotes }
          return { ...(prev ?? {}), screenplayBeats: beats }
        })
      }
    } catch {
      setAiMovieStageError(t.genericError)
    }
    setIsRunningAiMovieScriptDoctor(false)
  }

  async function handleWriteAiMovieSongSheetClick(beatIndex) {
    if (!aiMovieProjectId) return
    setIsWritingAiMovieSongSheet(true)
    setAiMovieStageError(null)
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/stages/screenplay/beats/${beatIndex}/song`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: aiMovieProjectId }),
      })
      const data = await response.json()
      if (!response.ok) {
        setAiMovieStageError(data.error || t.genericError)
      } else {
        setAiMovieBackfillResult((prev) => {
          const beats = [...(prev?.screenplayBeats ?? [])]
          beats[beatIndex] = { ...(beats[beatIndex] ?? {}), song: data.song }
          return { ...(prev ?? {}), screenplayBeats: beats }
        })
      }
    } catch {
      setAiMovieStageError(t.genericError)
    }
    setIsWritingAiMovieSongSheet(false)
  }

  // Places the INTERVAL after the given beat, or removes it (null).
  async function handleSetAiMovieIntervalClick(afterBeat) {
    if (!aiMovieProjectId) return
    setIsSavingAiMovieInterval(true)
    setAiMovieStageError(null)
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/projects/${aiMovieProjectId}/interval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ afterBeat }),
      })
      const data = await response.json()
      if (!response.ok) {
        setAiMovieStageError(data.error || t.genericError)
      } else {
        setAiMovieBackfillResult((prev) => ({ ...(prev ?? {}), intervalAfterBeat: data.intervalAfterBeat }))
      }
    } catch {
      setAiMovieStageError(t.genericError)
    }
    setIsSavingAiMovieInterval(false)
  }

  // Grows a written-but-short beat to its fixed Beat Sheet time, keeping
  // every existing scene and dialogue line -- the target itself never
  // changes; only more screenplay is added. Shares the regenerate button's
  // busy flag, since both are whole-beat AI operations.
  async function handleExtendAiMovieScreenplayBeatClick(beatIndex) {
    if (!aiMovieProjectId) return
    const projectId = aiMovieProjectId

    setIsGeneratingAiMovieScreenplayBeat(true)
    setAiMovieStageError(null)
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/stages/screenplay/beats/${beatIndex}/extend-to-target`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      })
      const data = await response.json()
      if (!response.ok) {
        setAiMovieStageError(data.error || t.genericError)
      } else {
        setAiMovieBackfillResult((prev) => {
          const beats = [...(prev?.screenplayBeats ?? [])]
          beats[beatIndex] = { ...(beats[beatIndex] ?? {}), scenes: data.scenes, status: 'pending' }
          return { ...(prev ?? {}), screenplayBeats: beats }
        })
      }
    } catch {
      setAiMovieStageError(t.genericError)
    }
    setIsGeneratingAiMovieScreenplayBeat(false)
  }

  // Also used as a plain retry (no feedback text) when a beat's status
  // came back "error".
  async function handleRegenerateAiMovieScreenplayBeatClick(beatIndex, feedback) {
    if (!aiMovieProjectId) return
    const projectId = aiMovieProjectId

    setIsGeneratingAiMovieScreenplayBeat(true)
    setAiMovieStageError(null)
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/stages/screenplay/beats/${beatIndex}/request-changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, feedback: feedback || undefined }),
      })
      const data = await response.json()
      if (!response.ok) {
        setAiMovieStageError(data.error || t.genericError)
      } else {
        setAiMovieBackfillResult((prev) => {
          const beats = [...(prev?.screenplayBeats ?? [])]
          beats[beatIndex] = { ...(beats[beatIndex] ?? {}), scenes: data.scenes, status: 'pending', feedback: feedback || null, doctorNotes: null }
          // The beat's own runtimeMinutes target (in `plot`) stays exactly
          // as the Beat Sheet set it -- it's the film's fixed pacing, never
          // adjusted to match whatever a regeneration happened to produce.
          return { ...(prev ?? {}), screenplayBeats: beats }
        })
        setShowAiMovieScreenplayBeatFeedbackForm(false)
        setAiMovieScreenplayBeatFeedbackText('')
      }
    } catch {
      setAiMovieStageError(t.genericError)
    }
    setIsGeneratingAiMovieScreenplayBeat(false)
  }

  // Lets the user pick any one scene (approved beat or not) and ask for any
  // kind of change -- longer, shorter, different tone/content, a fixed
  // detail, or anything else -- scoped to that one scene only, leaving its
  // siblings in the same beat untouched. The beat's own runtimeMinutes
  // target stays fixed (it's the Beat Sheet's designed pacing) -- a longer
  // revised scene simply shows the beat as over target.
  async function handleReviseAiMovieScreenplaySceneClick(beatIndex, sceneIndex, instruction, doctorNoteIndex) {
    if (!aiMovieProjectId) return
    const projectId = aiMovieProjectId

    setIsRevisingAiMovieScreenplayScene(true)
    setAiMovieStageError(null)
    try {
      const response = await fetch(
        `${BACKEND_URL}/api/ai-movie/stages/screenplay/beats/${beatIndex}/scenes/${sceneIndex}/revise`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, instruction: instruction || undefined, doctorNoteIndex }),
        }
      )
      const data = await response.json()
      if (!response.ok) {
        setAiMovieStageError(data.error || t.genericError)
      } else {
        setAiMovieBackfillResult((prev) => {
          const beats = [...(prev?.screenplayBeats ?? [])]
          const existing = beats[beatIndex] ?? {}
          beats[beatIndex] = { ...existing, scenes: data.scenes, status: 'pending', doctorNotes: data.doctorNotes ?? existing.doctorNotes }
          return { ...(prev ?? {}), screenplayBeats: beats }
        })
        setAiMovieRevisingSceneIndex(null)
        setAiMovieReviseSceneText('')
      }
    } catch {
      setAiMovieStageError(t.genericError)
    }
    setIsRevisingAiMovieScreenplayScene(false)
  }

  // Only available once the beat is approved -- dialogue is a refinement
  // made on an already-finalized scene, right in place, never a separate
  // pass done after the whole screenplay. Doesn't touch the scene's own
  // heading/action, so unlike a revision this never puts the beat back to
  // "pending."
  function applyAiMovieSceneDialogue(beatIndex, sceneIndex, data) {
    setAiMovieBackfillResult((prev) => {
      const beats = [...(prev?.screenplayBeats ?? [])]
      const existing = beats[beatIndex]
      if (!existing) return prev ?? {}
      const scenes = existing.scenes.map((s, i) => (i === sceneIndex
          ? {
              ...s,
              content: data.content,
              characters: data.characters,
              ...(typeof data.estimatedMinutes === 'number' ? { estimatedMinutes: data.estimatedMinutes } : {}),
            }
          : s))
      beats[beatIndex] = { ...existing, scenes }
      return { ...(prev ?? {}), screenplayBeats: beats }
    })
  }

  async function postAiMovieSceneDialogue(projectId, beatIndex, sceneIndex, body) {
    const response = await fetch(
      `${BACKEND_URL}/api/ai-movie/stages/screenplay/beats/${beatIndex}/scenes/${sceneIndex}/dialogue`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, ...body }),
      }
    )
    const data = await response.json()
    return { ok: response.ok, data }
  }

  async function handleWriteAiMovieDialogueClick(beatIndex, sceneIndex, instruction) {
    if (!aiMovieProjectId) return
    const projectId = aiMovieProjectId

    setIsWritingAiMovieDialogue(true)
    setAiMovieDialogueError(null)
    try {
      const { ok, data } = await postAiMovieSceneDialogue(projectId, beatIndex, sceneIndex, { instruction: instruction || undefined })
      if (!ok) {
        setAiMovieDialogueError({ key: `${beatIndex}-${sceneIndex}`, message: data.error || t.genericError })
      } else {
        applyAiMovieSceneDialogue(beatIndex, sceneIndex, data)
        setAiMovieDialogueSceneIndex(null)
        setAiMovieDialogueInstructionText('')
      }
    } catch {
      setAiMovieDialogueError({ key: `${beatIndex}-${sceneIndex}`, message: t.genericError })
    }
    setIsWritingAiMovieDialogue(false)
  }

  // One narrator voice-over across the whole beat (user request): the
  // scenes go through Write Dialogue one at a time, in order, with the
  // same brief, so each scene continues the narration saved in the one
  // before it. Stops at the first scene that fails, keeping what's done.
  async function handleWriteAiMovieBeatNarrationClick(beatIndex, brief) {
    if (!aiMovieProjectId || !brief.trim()) return
    const projectId = aiMovieProjectId
    const sceneCount = aiMovieBackfillResult?.screenplayBeats?.[beatIndex]?.scenes?.length ?? 0

    setIsWritingAiMovieDialogue(true)
    setAiMovieNarrationError(null)
    let failed = false
    for (let sceneIndex = 0; sceneIndex < sceneCount; sceneIndex++) {
      setAiMovieNarrationProgress({ scene: sceneIndex + 1, total: sceneCount })
      try {
        const { ok, data } = await postAiMovieSceneDialogue(projectId, beatIndex, sceneIndex, { narrationBrief: brief })
        if (!ok) {
          setAiMovieNarrationError(t.aiMovieBeatNarrationSceneError(sceneIndex + 1, data.error || t.genericError))
          failed = true
          break
        }
        applyAiMovieSceneDialogue(beatIndex, sceneIndex, data)
      } catch {
        setAiMovieNarrationError(t.aiMovieBeatNarrationSceneError(sceneIndex + 1, t.genericError))
        failed = true
        break
      }
    }
    setAiMovieNarrationProgress(null)
    setIsWritingAiMovieDialogue(false)
    if (!failed) {
      setAiMovieNarrationBeatIndex(null)
      setAiMovieNarrationText('')
    }
  }

  // Fallback duration for a beat or scene written before runtimeMinutes/
  // estimatedMinutes existed on its own -- older projects (and beats/
  // scenes generated before that field shipped) have no stored duration at
  // all, so without this they'd simply show nothing. A rough, deterministic
  // word-count estimate (roughly the standard "1 page / ~1 minute" rule,
  // at an action-line-sparse ~180 words per page) beats no number, and
  // fresh generations already ask the AI directly for a real estimate via
  // the schema -- this only ever fills a genuine gap.
  function estimateAiMovieMinutesFromText(text) {
    if (!text) return 0.5
    const wordCount = text.trim().split(/\s+/).filter(Boolean).length
    const minutes = Math.round((wordCount / 180) * 2) / 2
    return Math.max(0.5, minutes)
  }

  // A beat's own real, already-written scenes are a better duration signal
  // than its description text once any exist -- falls back to estimating
  // from the beat's own description only for a beat with no scenes yet.
  function effectiveAiMovieBeatMinutes(beat, screenplayBeatEntry) {
    if (typeof beat?.runtimeMinutes === 'number') return beat.runtimeMinutes
    const scenes = screenplayBeatEntry?.scenes
    if (Array.isArray(scenes) && scenes.length > 0) {
      const total = scenes.reduce((sum, scene) => sum + effectiveAiMovieSceneMinutes(scene), 0)
      return total
    }
    return estimateAiMovieMinutesFromText(beat?.description?.en)
  }

  function effectiveAiMovieSceneMinutes(scene) {
    if (typeof scene?.estimatedMinutes === 'number') return scene.estimatedMinutes
    return estimateAiMovieMinutesFromText(scene?.action?.en)
  }

  // Collapsed by default once a stage is approved (so the page reads as a
  // compact list of "done" headers instead of a long scroll), expanded
  // while it's still the one being worked on. An explicit click always
  // overrides that default, in either direction.
  function isAiMovieStageCollapsed(stageKey, isApproved) {
    const override = aiMovieExpandedStages[stageKey]
    if (override !== undefined) return !override
    return isApproved
  }

  function toggleAiMovieStageExpanded(stageKey, currentlyCollapsed) {
    setAiMovieExpandedStages((prev) => ({ ...prev, [stageKey]: currentlyCollapsed }))
  }

  function startEditingAiMovieScene(beatIndex, sceneIndex, scene) {
    const pick = (value) => (value?.[aiMovieLanguage] || value?.en || '')
    let blocks
    if (Array.isArray(scene.content) && scene.content.length > 0) {
      blocks = scene.content.map((block) =>
        block.type === 'dialogue'
          ? { type: 'dialogue', character: block.character ?? '', parenthetical: pick(block.parenthetical), extension: block.extension ?? '', line: pick(block.line) }
          : block.type === 'transition'
            ? { type: 'transition', transition: block.transition ?? '' }
            : { type: 'action', text: pick(block.text) }
      )
    } else {
      blocks = [{ type: 'action', text: pick(scene.action) }]
      for (const line of scene.dialogue ?? []) {
        blocks.push({ type: 'dialogue', character: line.character ?? '', parenthetical: '', extension: '', line: pick(line.line) })
      }
    }
    setAiMovieEditingScene({ key: `${beatIndex}-${sceneIndex}`, heading: scene.sceneHeading?.en ?? '', blocks })
    setAiMovieSceneEditError(null)
    setAiMovieSceneEditFixes(null)
    setAiMovieSelectedSceneIndex(sceneIndex)
  }

  function updateAiMovieEditBlock(blockIndex, patch) {
    setAiMovieEditingScene((prev) => prev && { ...prev, blocks: prev.blocks.map((b, i) => (i === blockIndex ? { ...b, ...patch } : b)) })
  }

  function insertAiMovieEditBlock(afterIndex, type) {
    const block = type === 'dialogue' ? { type: 'dialogue', character: '', parenthetical: '', extension: '', line: '' } : { type: 'action', text: '' }
    setAiMovieEditingScene((prev) => prev && { ...prev, blocks: [...prev.blocks.slice(0, afterIndex + 1), block, ...prev.blocks.slice(afterIndex + 1)] })
  }

  function removeAiMovieEditBlock(blockIndex) {
    setAiMovieEditingScene((prev) => prev && { ...prev, blocks: prev.blocks.filter((_, i) => i !== blockIndex) })
  }

  async function submitAiMovieSceneEdit(beatIndex, sceneIndex) {
    if (!aiMovieProjectId || !aiMovieEditingScene) return
    setIsSubmittingAiMovieSceneEdit(true)
    setAiMovieSceneEditError(null)
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/stages/screenplay/beats/${beatIndex}/scenes/${sceneIndex}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: aiMovieProjectId,
          language: aiMovieLanguage,
          sceneHeading: aiMovieEditingScene.heading,
          blocks: aiMovieEditingScene.blocks,
        }),
      })
      const data = await response.json()
      if (!response.ok) {
        setAiMovieSceneEditError(data.error || t.genericError)
      } else {
        setAiMovieBackfillResult((prev) => {
          const beats = [...(prev?.screenplayBeats ?? [])]
          const existing = beats[beatIndex]
          if (!existing) return prev ?? {}
          beats[beatIndex] = { ...existing, scenes: existing.scenes.map((s, i) => (i === sceneIndex ? data.scene : s)) }
          return { ...(prev ?? {}), screenplayBeats: beats }
        })
        setAiMovieSceneEditFixes({ key: `${beatIndex}-${sceneIndex}`, fixes: data.fixes ?? [] })
        setAiMovieEditingScene(null)
      }
    } catch {
      setAiMovieSceneEditError(t.genericError)
    }
    setIsSubmittingAiMovieSceneEdit(false)
  }

  // The scene being typed into, laid out exactly like the printed page:
  // each action / name / acting note / line is a borderless field in the
  // same font and indent, with small +/× controls in the right margin.
  function renderAiMovieEditableScene(beatIndex, sceneIndex, sceneNumber) {
    const editing = aiMovieEditingScene
    const rowsFor = (text, width) => Math.max(1, (text ?? '').split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / width)), 0))
    return (
      <div key={sceneIndex} id={`script-scene-${sceneIndex}`} className="script-scene is-selected is-editing">
        <p className="script-slug">
          <span className="script-scene-number script-scene-number-left">{sceneNumber}</span>
          <input
            className="script-edit-field script-edit-slug"
            value={editing.heading}
            onChange={(e) => setAiMovieEditingScene((prev) => ({ ...prev, heading: e.target.value }))}
            aria-label={t.scriptEditHeadingLabel}
          />
          <span className="script-scene-number script-scene-number-right">{sceneNumber}</span>
        </p>
        {editing.blocks.map((block, blockIndex) => (
          <div key={blockIndex} className={`script-edit-block script-edit-block-${block.type}`}>
            {block.type === 'dialogue' ? (
              <div className="script-dialogue">
                <input
                  className="script-edit-field script-character"
                  value={block.character}
                  onChange={(e) => updateAiMovieEditBlock(blockIndex, { character: e.target.value.toUpperCase() })}
                  placeholder={t.scriptEditCharacterPlaceholder}
                />
                <input
                  className="script-edit-field script-parenthetical"
                  value={block.parenthetical}
                  onChange={(e) => updateAiMovieEditBlock(blockIndex, { parenthetical: e.target.value })}
                  placeholder={t.scriptEditParentheticalPlaceholder}
                />
                <textarea
                  className="script-edit-field script-line"
                  value={block.line}
                  rows={rowsFor(block.line, 35)}
                  onChange={(e) => updateAiMovieEditBlock(blockIndex, { line: e.target.value })}
                  placeholder={t.scriptEditLinePlaceholder}
                />
              </div>
            ) : block.type === 'transition' ? (
              <input
                className="script-edit-field script-transition"
                value={block.transition}
                onChange={(e) => updateAiMovieEditBlock(blockIndex, { transition: e.target.value.toUpperCase() })}
              />
            ) : (
              <textarea
                className="script-edit-field script-action"
                value={block.text}
                rows={rowsFor(block.text, 60)}
                onChange={(e) => updateAiMovieEditBlock(blockIndex, { text: e.target.value })}
                placeholder={t.scriptEditActionPlaceholder}
              />
            )}
            <div className="script-edit-controls">
              <button type="button" onClick={() => insertAiMovieEditBlock(blockIndex, 'action')} title={t.scriptEditAddActionButton}>+ {t.scriptEditActionShort}</button>
              <button type="button" onClick={() => insertAiMovieEditBlock(blockIndex, 'dialogue')} title={t.scriptEditAddDialogueButton}>+ {t.scriptEditDialogueShort}</button>
              <button type="button" onClick={() => removeAiMovieEditBlock(blockIndex)} title={t.scriptEditRemoveButton} aria-label={t.scriptEditRemoveButton}>×</button>
            </div>
          </div>
        ))}
        {editing.blocks.length === 0 && (
          <div className="script-edit-controls is-visible">
            <button type="button" onClick={() => insertAiMovieEditBlock(-1, 'action')}>+ {t.scriptEditActionShort}</button>
            <button type="button" onClick={() => insertAiMovieEditBlock(-1, 'dialogue')}>+ {t.scriptEditDialogueShort}</button>
          </div>
        )}
        <div className="script-edit-submit-bar">
          <p>{t.scriptEditSubmitNote}</p>
          <div>
            <button type="button" className="cancel-button" onClick={() => setAiMovieEditingScene(null)} disabled={isSubmittingAiMovieSceneEdit}>
              {t.aiMovieReviseSceneCancelButton}
            </button>
            <button type="button" className="choose-button" onClick={() => submitAiMovieSceneEdit(beatIndex, sceneIndex)} disabled={isSubmittingAiMovieSceneEdit}>
              {isSubmittingAiMovieSceneEdit ? t.scriptEditSubmittingLabel : t.scriptEditSubmitButton}
            </button>
          </div>
          {aiMovieSceneEditError && <p className="feedback-note">{aiMovieSceneEditError}</p>}
        </div>
      </div>
    )
  }

  // Full script check (the user's choice): starts it in the background,
  // then quietly refreshes its progress (and the corrected scenes) every
  // few seconds until it's done.
  const [aiMovieScriptCheckError, setAiMovieScriptCheckError] = useState(null)
  const [showAiMovieScriptCheckReport, setShowAiMovieScriptCheckReport] = useState(false)

  async function pollAiMovieScriptCheck(projectId) {
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/projects/${projectId}`)
      const data = await response.json()
      if (!response.ok) return
      setAiMovieBackfillResult((prev) => ({
        ...(prev ?? {}),
        screenplayBeats: data.backfill?.screenplayBeats ?? prev?.screenplayBeats ?? [],
        scriptCheck: data.backfill?.scriptCheck ?? null,
      }))
      if (data.backfill?.scriptCheck?.status === 'running') {
        setTimeout(() => pollAiMovieScriptCheck(projectId), 5000)
      }
    } catch {
      setTimeout(() => pollAiMovieScriptCheck(projectId), 10000)
    }
  }

  async function handleStartAiMovieScriptCheckClick(writtenBeatCount) {
    if (!aiMovieProjectId) return
    if (!window.confirm(t.aiMovieScriptCheckConfirm(writtenBeatCount))) return
    setAiMovieScriptCheckError(null)
    try {
      const response = await fetch(`${BACKEND_URL}/api/ai-movie/projects/${aiMovieProjectId}/script-check`, { method: 'POST' })
      const data = await response.json()
      if (!response.ok) {
        setAiMovieScriptCheckError(data.error || t.genericError)
        return
      }
      setShowAiMovieScriptCheckReport(false)
      pollAiMovieScriptCheck(aiMovieProjectId)
    } catch {
      setAiMovieScriptCheckError(t.genericError)
    }
  }

  function shownAiMovieStage() {
    return aiMovieFocusedStage ?? getAiMovieCurrentStage(aiMovieStageStatus)?.key ?? 'screenplay'
  }

  function handleAiMovieStageClick(stageKey) {
    setIsSidebarOpen(false)
    setAiMovieFocusedStage(stageKey)
    // A stage opened from the menu is shown open, even if it's approved.
    setAiMovieExpandedStages((prev) => ({ ...prev, [stageKey]: true }))
    window.scrollTo({ top: 0, behavior: 'smooth' })
    document.querySelector('.chat-viewport')?.scrollTo?.({ top: 0, behavior: 'smooth' })
  }

  function handleAiMovieExportClick() {
    if (!aiMovieProjectId) return

    setIsExportingAiMovieProject(true)
    try {
      const project = {
        title: aiMovieProjectTitle,
        pastedText: aiMovieAnalyzeInput,
        detectedStage: aiMovieAnalyzeStage,
        backfill: aiMovieBackfillResult,
        assets: aiMovieAssets,
        stageStatus: aiMovieStageStatus,
      }
      const payload = { exportedFrom: 'filmmaking-app-ai-movie', version: 2, project }

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      const nameBase = (aiMovieProjectTitle || aiMovieAnalyzeInput || 'ai-movie-project').slice(0, 40).replace(/[^\w\- ]/g, '').trim() || 'ai-movie-project'
      link.href = url
      link.download = `${nameBase}-${formatExportTimestamp()}.json`
      link.click()
      URL.revokeObjectURL(url)
    } catch {
      setAiMovieAnalyzeError(t.genericError)
    }
    setIsExportingAiMovieProject(false)
  }

  async function handleAiMovieImportFileSelected(event) {
    const file = event.target.files[0]
    event.target.value = ''
    if (!file) return

    setAiMovieAnalyzeError(null)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)

      const response = await fetch(`${BACKEND_URL}/api/ai-movie/projects/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: parsed.project }),
      })
      const data = await response.json()

      if (!response.ok) {
        setAiMovieAnalyzeError(data.error || t.genericError)
        return
      }

      await loadAiMovieProject(data.id)
    } catch {
      setAiMovieAnalyzeError(t.importInvalidFile)
    }
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

  function handleNewIdeaClick(forAgent = activeAgent) {
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
    setProjectType(forAgent)
    setImportScreenplayText('')
    setStartStage('idea')
    setClearDraftHistorySignal((n) => n + 1)
  }

  function handleGoHomeClick() {
    if (isScopedToOneProject) return
    setActiveAgent('story')
    handleNewIdeaClick('story')
    setIsSidebarOpen(false)
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
      link.download = `${nameBase}-${formatExportTimestamp()}.json`
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
    if (!conceptId) {
      setErrorMessage(t.genericError)
      return
    }

    breakdownPollCancelRef.current = false
    setIsGeneratingBreakdown(true)
    setErrorMessage(null)
    setToastMessage(null)

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

      // A long script's first breakdown can take several minutes (a first
      // pass plus 5 concurrent per-category refinement calls) — the server
      // now kicks it off and responds right away instead of holding the
      // request open, so pick up the finished result by polling the
      // project's own data instead of waiting on this one response.
      await pollForScriptBreakdown(conceptId, null, setIsGeneratingBreakdown)
    } catch {
      setErrorMessage(t.genericError)
      setIsGeneratingBreakdown(false)
    }
  }

  function handleCancelBreakdownPollClick() {
    breakdownPollCancelRef.current = true
    setIsGeneratingBreakdown(false)
    setIsGeneratingAdSheet(false)
  }

  // Shared by both "Analyze Script" (afterBreakdownId=null — any breakdown
  // showing up is the new one) and "Generate AD Sheet" (a breakdown already
  // exists, so this waits for a NEWER row specifically, since otherwise
  // it'd resolve instantly against the one already there).
  async function pollForScriptBreakdown(pollConceptId, afterBreakdownId, setIsBusy) {
    const pollIntervalMs = 5000
    const maxAttempts = 240 // 20 minutes

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
      if (breakdownPollCancelRef.current) return

      try {
        const response = await fetch(`${BACKEND_URL}/api/concepts/${pollConceptId}/full`)
        if (response.ok) {
          const data = await response.json()
          if (data.scriptBreakdown && (afterBreakdownId == null || data.scriptBreakdown.id !== afterBreakdownId)) {
            setScriptBreakdown(data.scriptBreakdown)
            setIsBusy(false)
            return
          }
        }
      } catch {
        // A single missed poll isn't fatal — just try again next tick.
      }
    }

    setErrorMessage(t.breakdownTimedOutError)
    setIsBusy(false)
  }

  async function handleGenerateAdSheetClick() {
    if (!conceptId) {
      setErrorMessage(t.genericError)
      return
    }

    breakdownPollCancelRef.current = false
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

      // Same batched-and-sequential background job as Analyze Script — see
      // that handler's comment — so this also polls for the new row
      // instead of waiting on one long-lived request.
      await pollForScriptBreakdown(conceptId, scriptBreakdown.id, setIsGeneratingAdSheet)
    } catch {
      setErrorMessage(t.genericError)
      setIsGeneratingAdSheet(false)
    }
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
      return { location: { en: '', or: '', hi: '' }, intExt: 'INT', sceneCount: 1, notes: { en: '', or: '', hi: '' } }
    }
    if (category === 'costumes') {
      return { character: '', description: { en: '', or: '', hi: '' } }
    }
    if (category === 'artistList') {
      return { label: '', notes: { en: '', or: '', hi: '' }, age: 'Unspecified', gender: 'Unspecified' }
    }
    return { label: '', notes: { en: '', or: '', hi: '' } }
  }

  function handleStartEditCategory(category) {
    setEditingBreakdownCategory(category)
    const items = JSON.parse(JSON.stringify(scriptBreakdown[category] ?? []))
    // Older breakdown items generated before Hindi support may be missing
    // the `hi` key entirely — backfill it so the edit inputs stay controlled.
    items.forEach((item) => {
      if (item.location) item.location.hi = item.location.hi ?? ''
      if (item.notes) item.notes.hi = item.notes.hi ?? ''
      if (item.description) item.description.hi = item.description.hi ?? ''
    })
    setBreakdownCategoryDraft(items)
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

  async function handleClassifyCastCategoriesClick() {
    setIsClassifyingCastCategories(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/classify-cast-categories`, {
        method: 'POST',
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsClassifyingCastCategories(false)
        return
      }

      setScriptBreakdown(data)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsClassifyingCastCategories(false)
  }

  async function handleClassifyEpisodeNumbersClick() {
    setIsClassifyingEpisodeNumbers(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/classify-episode-numbers`, {
        method: 'POST',
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsClassifyingEpisodeNumbers(false)
        return
      }

      setScriptBreakdown(data)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsClassifyingEpisodeNumbers(false)
  }

  async function handleGenerateCostumeRecommendationClick(characterName) {
    setGeneratingCostumeRecommendationFor(characterName)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/generate-costume-recommendation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character: characterName }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setGeneratingCostumeRecommendationFor(null)
        return
      }

      setScriptBreakdown(data)
    } catch {
      setErrorMessage(t.genericError)
    }

    setGeneratingCostumeRecommendationFor(null)
  }

  async function handleApproveCostumeRecommendationClick(characterName) {
    setApprovingCostumeRecommendationFor(characterName)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/approve-costume-recommendation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character: characterName }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setApprovingCostumeRecommendationFor(null)
        return
      }

      setScriptBreakdown(data)
    } catch {
      setErrorMessage(t.genericError)
    }

    setApprovingCostumeRecommendationFor(null)
  }

  function handleStartEditCostumeSets(characterName, currentSets) {
    setEditingCostumeSetsFor(characterName)
    setCostumeSetsDraft(
      currentSets.map((s) => ({ category: s.category, quantity: String(s.quantity), reasonEn: s.reason?.en ?? '' }))
    )
  }

  function handleCancelEditCostumeSets() {
    setEditingCostumeSetsFor(null)
    setCostumeSetsDraft([])
  }

  function handleCostumeSetDraftFieldChange(index, field, value) {
    setCostumeSetsDraft((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
  }

  function handleAddCostumeSetRow() {
    setCostumeSetsDraft((prev) => [...prev, { category: '', quantity: '1', reasonEn: '' }])
  }

  function handleRemoveCostumeSetRow(index) {
    setCostumeSetsDraft((prev) => prev.filter((_, i) => i !== index))
  }

  async function handleSaveCostumeSetsClick(characterName) {
    const cleanSets = costumeSetsDraft.filter((row) => row.category.trim())
    setIsSavingCostumeSets(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/set-costume-recommendation-sets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          character: characterName,
          sets: cleanSets.map((row) => ({ category: row.category.trim(), quantity: Number(row.quantity) || 1, reasonEn: row.reasonEn.trim() })),
        }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsSavingCostumeSets(false)
        return
      }

      setScriptBreakdown(data)
      setEditingCostumeSetsFor(null)
      setCostumeSetsDraft([])
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsSavingCostumeSets(false)
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
            <DownloadChoiceButton
              t={t}
              label={t.downloadLabel}
              pdfUrl={`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/export?category=${category}&lang=${language}`}
              excelUrl={`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/export-excel?category=${category}&lang=${language}`}
            />
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

        <AnalyzingProgressBar active={isReanalyzing} label={t.reanalyzingLabel} estimatedSeconds={20} />

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
          (category === 'artistList'
            ? items
                .map((item, originalIndex) => ({ item, originalIndex }))
                .sort((a, b) => (CAST_TIER_GROUP_ORDER[castTierGroup(a.item)] ?? -1) - (CAST_TIER_GROUP_ORDER[castTierGroup(b.item)] ?? -1))
            : items.map((item, originalIndex) => ({ item, originalIndex }))
          ).map(({ item, originalIndex }, sortedIndex, sortedArray) => {
            const index = originalIndex
            const itemKey = `${category}:${index}`
            const tierGroup = category === 'artistList' ? castTierGroup(item) : null
            const showCastCategoryHeader =
              category === 'artistList' && (sortedIndex === 0 || castTierGroup(sortedArray[sortedIndex - 1].item) !== tierGroup)
            // Extras/juniors share ONE coordinator slot instead of being cast
            // individually; non-speaking characters aren't cast at all — so
            // "finalized" for either group isn't about THIS specific item.
            const isExtraTier = tierGroup === 'extra'
            const isNonSpeakingTier = tierGroup === 'non_speaking'
            const isExpanded = Boolean(expandedBreakdownItems[itemKey])
            const isCastFinalized =
              category === 'artistList' &&
              (isExtraTier
                ? crewMembers.some((m) => m.category === 'artist' && m.characterName === JUNIOR_ARTIST_COORDINATOR_KEY)
                : crewMembers.some((m) => m.category === 'artist' && m.characterName === item.label))
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
              <Fragment key={index}>
                {showCastCategoryHeader && (
                  <p className="cast-category-header">{castTierGroupLabel(tierGroup, t)}</p>
                )}
                {showCastCategoryHeader && isExtraTier && (
                  <div className="junior-artist-coordinator">
                    <strong>{t.juniorArtistCoordinatorHeading}</strong>
                    <p className="breakdown-item-meta">{t.juniorArtistCoordinatorHint}</p>
                    <InlineCastAttachment
                      category="artist"
                      linkKey={JUNIOR_ARTIST_COORDINATOR_KEY}
                      members={crewMembers.filter((m) => m.category === 'artist' && m.characterName === JUNIOR_ARTIST_COORDINATOR_KEY)}
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
                  </div>
                )}
                <div className="breakdown-item">
                <button className="breakdown-item-toggle" onClick={() => toggleBreakdownItem(itemKey)}>
                  <span className={isExpanded ? 'breakdown-item-chevron expanded' : 'breakdown-item-chevron'}>▸</span>
                  {category === 'locationList' ? (
                    <>
                      <strong>{item.location[language]}</strong>{' '}
                      <span className="breakdown-item-meta">
                        ({item.intExt} — {item.sceneCount} {t.scenesLabel})
                      </span>
                      {formatEpisodeNumbers(item, t) && (
                        <span className="breakdown-item-episodes">{formatEpisodeNumbers(item, t)}</span>
                      )}
                      <span className={isLocationFinalized ? 'breakdown-item-chip finalized' : 'breakdown-item-chip pending'}>
                        {isLocationFinalized ? '✓' : '…'}
                      </span>
                    </>
                  ) : category === 'costumes' ? (
                    <>
                      <strong>{item.character}</strong>
                      {formatEpisodeNumbers(item, t) && (
                        <span className="breakdown-item-episodes">{' '}{formatEpisodeNumbers(item, t)}</span>
                      )}
                    </>
                  ) : category === 'artistList' ? (
                    <>
                      <strong className={shootStatus ? `artist-name-${shootStatus}` : ''}>{item.label}</strong>{' '}
                      <span className="breakdown-item-meta">
                        ({item.gender || t.unspecifiedLabel}, {item.age || t.unspecifiedLabel})
                      </span>
                      {formatEpisodeNumbers(item, t) && (
                        <span className="breakdown-item-episodes">{formatEpisodeNumbers(item, t)}</span>
                      )}
                      {shootStatus && (
                        <span className={`artist-schedule-status-chip ${shootStatus}`}>
                          {shootStatus === 'wrapped' ? t.artistStatusWrappedLabel : shootStatus === 'in-progress' ? t.artistStatusInProgressLabel : t.artistStatusPendingLabel}
                        </span>
                      )}
                      {!isNonSpeakingTier && (
                        <span className={isCastFinalized ? 'breakdown-item-chip finalized' : 'breakdown-item-chip pending'}>
                          {isCastFinalized ? '✓' : '…'}
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <strong>{item.label}</strong>
                      {formatEpisodeNumbers(item, t) && (
                        <span className="breakdown-item-episodes">{' '}{formatEpisodeNumbers(item, t)}</span>
                      )}
                    </>
                  )}
                </button>

                {isExpanded && (
                  <>
                    <p>{category === 'costumes' ? item.description[language] : item.notes[language]}</p>

                    {/* Lead/Sidekick only — Extras/Juniors share ONE coordinator
                        slot above instead (see isExtraTier block), and
                        non-speaking characters aren't cast at all. */}
                    {category === 'artistList' && !isExtraTier && !isNonSpeakingTier && (
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
                    {category === 'costumes' &&
                      (() => {
                        const rec = scriptBreakdown.costumeRecommendations?.find(
                          (r) => r.character.toLowerCase() === item.character.toLowerCase()
                        )
                        const isGeneratingThis = generatingCostumeRecommendationFor === item.character
                        const isApprovingThis = approvingCostumeRecommendationFor === item.character
                        const isEditingSetsHere = editingCostumeSetsFor === item.character

                        if (!rec) {
                          return (
                            canEditProduction && (
                              <>
                                <button
                                  className="breakdown-action-button costume-recommendation-trigger"
                                  onClick={() => handleGenerateCostumeRecommendationClick(item.character)}
                                  disabled={isGeneratingThis || !scriptBreakdown.adSheet?.length}
                                  title={!scriptBreakdown.adSheet?.length ? t.costumeRecommendationsNeedsAdSheetHint : undefined}
                                >
                                  {isGeneratingThis ? t.generatingCostumeRecommendationsLabel : t.generateCostumeRecommendationsButton}
                                </button>
                                <AnalyzingProgressBar active={isGeneratingThis} label={t.generatingCostumeRecommendationsLabel} estimatedSeconds={20} />
                              </>
                            )
                          )
                        }

                        return (
                          <div className="costume-recommendation-inline">
                            <strong>{t.costumeRecommendationsHeading}</strong>{' '}
                            <span className="breakdown-item-meta">
                              ({rec.totalScenes} {t.scenesLabel})
                            </span>
                            {rec.approved && <span className="costume-recommendation-approved-badge">{t.costumeApprovedBadge}</span>}

                            {!isEditingSetsHere && (
                              <ul className="costume-recommendation-sets">
                                {rec.sets.map((set, i) => (
                                  <li key={i}>
                                    <strong>{set.quantity}×</strong> {set.category}
                                    {set.reason?.[language] && <span className="costume-recommendation-reason"> — {set.reason[language]}</span>}
                                  </li>
                                ))}
                              </ul>
                            )}

                            {isEditingSetsHere && (
                              <div className="costume-set-edit-list">
                                {costumeSetsDraft.map((row, i) => (
                                  <div className="costume-set-edit-row" key={i}>
                                    <MicInput
                                      placeholder={t.costumeSetCategoryPlaceholder}
                                      value={row.category}
                                      onChange={(e) => handleCostumeSetDraftFieldChange(i, 'category', e.target.value)}
                                    />
                                    <input
                                      type="number"
                                      min="1"
                                      placeholder={t.costumeSetQuantityPlaceholder}
                                      value={row.quantity}
                                      onChange={(e) => handleCostumeSetDraftFieldChange(i, 'quantity', e.target.value)}
                                    />
                                    <MicInput
                                      placeholder={t.costumeSetReasonPlaceholder}
                                      value={row.reasonEn}
                                      onChange={(e) => handleCostumeSetDraftFieldChange(i, 'reasonEn', e.target.value)}
                                    />
                                    <button
                                      className="costume-set-remove-button"
                                      onClick={() => handleRemoveCostumeSetRow(i)}
                                      title={t.removeCostumeSetButton}
                                    >
                                      ✕
                                    </button>
                                  </div>
                                ))}
                                <div className="costume-recommendation-controls">
                                  <button className="breakdown-action-button" onClick={handleAddCostumeSetRow}>
                                    {t.addCostumeSetButton}
                                  </button>
                                  <button
                                    className="choose-button"
                                    onClick={() => handleSaveCostumeSetsClick(item.character)}
                                    disabled={isSavingCostumeSets}
                                  >
                                    {isSavingCostumeSets ? t.applyingLabel : t.saveButton}
                                  </button>
                                  <button className="cancel-button" onClick={handleCancelEditCostumeSets} disabled={isSavingCostumeSets}>
                                    {t.cancelEditButton}
                                  </button>
                                </div>
                              </div>
                            )}

                            {canEditProduction && !rec.approved && !isEditingSetsHere && (
                              <div className="costume-recommendation-controls">
                                <button
                                  className="breakdown-action-button"
                                  onClick={() => handleGenerateCostumeRecommendationClick(item.character)}
                                  disabled={isGeneratingThis}
                                >
                                  {isGeneratingThis ? t.generatingCostumeRecommendationsLabel : t.regenerateCostumeRecommendationButton}
                                </button>
                                <button
                                  className="breakdown-action-button"
                                  onClick={() => handleStartEditCostumeSets(item.character, rec.sets)}
                                >
                                  {t.editCostumeSetsButton}
                                </button>
                                <button
                                  className="choose-button"
                                  onClick={() => handleApproveCostumeRecommendationClick(item.character)}
                                  disabled={isApprovingThis}
                                >
                                  {isApprovingThis ? t.applyingLabel : t.approveCostumeButton}
                                </button>
                              </div>
                            )}
                          </div>
                        )
                      })()}
                  </>
                )}
                </div>
              </Fragment>
            )
          })}

        {!isEditing && isCategoryExpanded && category === 'artistList' && canEditProduction && (
          <div className="add-missing-character-form">
            <MicInput
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
            {canAnalyzeScript && (
              <button
                className="breakdown-action-button"
                onClick={handleClassifyCastCategoriesClick}
                disabled={isClassifyingCastCategories}
                title={t.classifyCastCategoriesHint}
              >
                {isClassifyingCastCategories ? t.classifyingCastCategoriesLabel : t.classifyCastCategoriesButton}
              </button>
            )}
            <AnalyzingProgressBar active={isFindingMissingCharacters} label={t.findingMissingCharactersLabel} estimatedSeconds={25} />
            <AnalyzingProgressBar active={isClassifyingCastCategories} label={t.classifyingCastCategoriesLabel} estimatedSeconds={20} />
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
                      <MicInput
                        placeholder="Location (EN)"
                        value={item.location.en}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            location: { ...it.location, en: e.target.value },
                          }))
                        }
                      />
                      <MicInput
                        placeholder="ସ୍ଥାନ (OR)"
                        value={item.location.or}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            location: { ...it.location, or: e.target.value },
                          }))
                        }
                      />
                      <MicInput
                        placeholder="स्थान (HI)"
                        value={item.location.hi}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            location: { ...it.location, hi: e.target.value },
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
                      <MicTextarea
                        placeholder="Notes (EN)"
                        value={item.notes.en}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            notes: { ...it.notes, en: e.target.value },
                          }))
                        }
                      />
                      <MicTextarea
                        placeholder="ମନ୍ତବ୍ୟ (OR)"
                        value={item.notes.or}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            notes: { ...it.notes, or: e.target.value },
                          }))
                        }
                      />
                      <MicTextarea
                        placeholder="टिप्पणी (HI)"
                        value={item.notes.hi}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            notes: { ...it.notes, hi: e.target.value },
                          }))
                        }
                      />
                    </div>
                  </>
                ) : category === 'costumes' ? (
                  <>
                    <MicInput
                      placeholder="Character"
                      value={item.character}
                      onChange={(e) =>
                        handleBreakdownDraftFieldChange(index, (it) => ({ ...it, character: e.target.value }))
                      }
                    />
                    <div className="breakdown-edit-field-pair">
                      <MicTextarea
                        placeholder="Description (EN)"
                        value={item.description.en}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            description: { ...it.description, en: e.target.value },
                          }))
                        }
                      />
                      <MicTextarea
                        placeholder="ବିବରଣୀ (OR)"
                        value={item.description.or}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            description: { ...it.description, or: e.target.value },
                          }))
                        }
                      />
                      <MicTextarea
                        placeholder="विवरण (HI)"
                        value={item.description.hi}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            description: { ...it.description, hi: e.target.value },
                          }))
                        }
                      />
                    </div>
                  </>
                ) : category === 'artistList' ? (
                  <>
                    <MicInput
                      placeholder="Label"
                      value={item.label}
                      onChange={(e) =>
                        handleBreakdownDraftFieldChange(index, (it) => ({ ...it, label: e.target.value }))
                      }
                    />
                    <div className="breakdown-edit-field-pair">
                      <MicInput
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
                      <MicTextarea
                        placeholder="Notes (EN)"
                        value={item.notes.en}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            notes: { ...it.notes, en: e.target.value },
                          }))
                        }
                      />
                      <MicTextarea
                        placeholder="ମନ୍ତବ୍ୟ (OR)"
                        value={item.notes.or}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            notes: { ...it.notes, or: e.target.value },
                          }))
                        }
                      />
                      <MicTextarea
                        placeholder="टिप्पणी (HI)"
                        value={item.notes.hi}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            notes: { ...it.notes, hi: e.target.value },
                          }))
                        }
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <MicInput
                      placeholder="Label"
                      value={item.label}
                      onChange={(e) =>
                        handleBreakdownDraftFieldChange(index, (it) => ({ ...it, label: e.target.value }))
                      }
                    />
                    <div className="breakdown-edit-field-pair">
                      <MicTextarea
                        placeholder="Notes (EN)"
                        value={item.notes.en}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            notes: { ...it.notes, en: e.target.value },
                          }))
                        }
                      />
                      <MicTextarea
                        placeholder="ମନ୍ତବ୍ୟ (OR)"
                        value={item.notes.or}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            notes: { ...it.notes, or: e.target.value },
                          }))
                        }
                      />
                      <MicTextarea
                        placeholder="टिप्पणी (HI)"
                        value={item.notes.hi}
                        onChange={(e) =>
                          handleBreakdownDraftFieldChange(index, (it) => ({
                            ...it,
                            notes: { ...it.notes, hi: e.target.value },
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
        body: JSON.stringify({
          dayNumber: day.dayNumber,
          reportText: dayCompletionReportText,
          extraReportText: extraSceneReportText,
        }),
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
      const extraSelections = {}
      ;(data.extraMatches ?? []).forEach((m) => {
        extraSelections[`${m.dayNumber}-${m.index}`] = true
      })
      setExtraSceneSelections(extraSelections)
      setDayCompletionParseResult(data)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsParsingDayCompletion(false)
  }

  async function handleConfirmDayShotClick(day) {
    setIsRecordingShotDay(true)
    setErrorMessage(null)

    const extraSceneRefs = Object.entries(extraSceneSelections)
      .filter(([, checked]) => checked)
      .map(([key]) => {
        const [dayNumberStr, indexStr] = key.split('-')
        const otherDay = shootSchedule.scheduleDays.find((d) => d.dayNumber === Number(dayNumberStr))
        return otherDay?.sceneRefs?.[Number(indexStr)]
      })
      .filter(Boolean)
    const shotSceneRefs = [
      ...day.sceneRefs.filter((_, index) => shotSceneSelections[index] !== false),
      ...extraSceneRefs,
    ]
    const notesWithCompletion = shotCompletionNote.trim()
      ? {
          en: [day.notes?.en, shotCompletionNote.trim()].filter(Boolean).join(' — '),
          or: day.notes?.or ?? '',
          hi: day.notes?.hi ?? '',
        }
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
      setExtraSceneReportText('')
      setExtraSceneSelections({})
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsRecordingShotDay(false)
  }

  async function handlePrepareNextDaysClick() {
    setIsPreparingNextDays(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/shoot-schedule/${shootSchedule.id}/request-changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: t.prepareNextDaysFeedback }),
      })
      const data = await response.json()

      if (!response.ok) {
        setErrorMessage(data.error || t.genericError)
        setIsPreparingNextDays(false)
        return
      }

      setShootSchedule(data)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsPreparingNextDays(false)
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
    setToastMessage(null)

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
      setToastMessage(t.screenplayUploadedToast)
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
    setToastMessage(null)

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
      setToastMessage(t.screenplayUploadedToast)
    } catch {
      setErrorMessage(t.genericError)
    }

    setIsImportingScreenplayFile(false)
  }

  function handleDialogueLanguageChange(key, value) {
    setDialogueLanguageByKey((prev) => ({ ...prev, [key]: value }))
  }

  async function handleWriteSceneClick(episodeIndex, sceneIndex, dialogueLanguage) {
    const key = screenplayKey(episodeIndex, sceneIndex)
    setGeneratingScreenplayKey(key)
    setErrorMessage(null)

    try {
      const response = await fetch(`${BACKEND_URL}/api/screenplay/scene`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneListId: sceneList.id, episodeIndex, sceneIndex, dialogueLanguage }),
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

  // Movie's Story & Screenplay menu works as switches, like AI Movie's
  // (the user's request): one stage in the centre at a time. null = follow
  // the stage being worked on right now. Production keeps its own
  // scroll-to menu, unchanged.
  const [movieFocusedStage, setMovieFocusedStage] = useState(null)
  const MOVIE_STAGE_BY_ANCHOR = { 'stage-idea': 'idea', 'stage-synopsis': 'synopsis', 'stage-characters': 'characters', 'stage-bitsheet': 'bitsheet', 'stage-screenplay': 'screenplay' }

  function handleStageClick(anchorId) {
    setIsSidebarOpen(false)
    if (MOVIE_STAGE_BY_ANCHOR[anchorId] && activeAgent === 'story') {
      setMovieFocusedStage(MOVIE_STAGE_BY_ANCHOR[anchorId])
      if (anchorId === 'stage-idea' && !storylines?.length) setOpenChangesChatSignal((n) => n + 1)
      window.scrollTo({ top: 0, behavior: 'smooth' })
      document.querySelector('.chat-viewport')?.scrollTo?.({ top: 0, behavior: 'smooth' })
      return
    }
    if (anchorId === 'stage-breakdown') setChatFocusStage('breakdown')
    if (anchorId === 'stage-schedule') setChatFocusStage('schedule')
    // Clicking "Idea" before anything's been generated yet pops the Changes
    // box open directly, instead of making the user find the pen icon —
    // it's the box you type your idea into.
    if (anchorId === 'stage-idea' && !storylines?.length) setOpenChangesChatSignal((n) => n + 1)
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
  // The Movie stage being worked on now -- where the screen opens, and
  // where it moves on to after each approval.
  const movieCurrentStage =
    !pitchDeck && !isGeneratingPitchDeck
      ? 'idea'
      : pitchDeck?.status !== 'approved'
        ? 'synopsis'
        : characterSheet?.status !== 'approved'
          ? 'characters'
          : bitSheet?.status !== 'approved'
            ? 'bitsheet'
            : 'screenplay'
  const shownMovieStage = movieFocusedStage ?? movieCurrentStage
  // Projects that aren't the step-by-step "story" kind keep showing every
  // stage, exactly as before.
  const movieShows = (stageKey) => (conceptId && projectType !== 'story') || shownMovieStage === stageKey
  // After an approval (or opening another project) the screen follows the
  // work again, the way the long column used to.
  useEffect(() => {
    setMovieFocusedStage(null)
  }, [movieCurrentStage, conceptId])
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

  // The conversational agent chat should stay available for ongoing
  // changes even after a stage is approved — it's not just a "revise before
  // approving" tool, so its own stage is picked independently of barConfig
  // (which goes 'idle' the moment everything's approved and would
  // otherwise make the whole chat vanish). Prefers 'schedule' once one
  // exists since that's the most advanced stage reached.
  const agentChatStageKey =
    chatFocusStage === 'breakdown' && scriptBreakdown
      ? 'breakdown'
      : chatFocusStage === 'schedule' && shootSchedule
        ? 'schedule'
        : shootSchedule
          ? 'schedule'
          : scriptBreakdown
            ? 'breakdown'
            : null

  if (currentUser === undefined) {
    return <div className="app-shell" />
  }

  if (currentUser === null) {
    return (
      <div className="login-screen">
        <form className="login-form" onSubmit={handleLoginSubmit}>
          <h1>{t.loginWelcomeHeading}</h1>
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

  if (appMode === null) {
    return (
      <div className="login-screen">
        <div className="format-picker">
          <h4 className="format-picker-title">{t.appModeQuestion}</h4>
          <div className="format-picker-row">
            <button type="button" className="choose-button" onClick={() => setAppMode('movie')}>
              {t.appModeMovieOption}
            </button>
            <button type="button" className="choose-button" onClick={handleChooseAiMovieMode}>
              {t.appModeAiMovieOption}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (appMode === 'ai') {
    // AI Movie's own UI chrome (button labels, headings) is English/Hindi
    // only, never Odia -- shadow the general en/or `t` with a fixed English
    // one here so it can't leak Odia in from the Movie-side language
    // dropdown (whose choice is a separate, persistent state that survives
    // switching into AI Movie mode). Content itself already uses its own
    // separate `aiMovieLanguage` (en/hi) toggle, untouched by this.
    const t = LABELS.en
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
            <span className="sidebar-home-button">
              <span className="sidebar-logo">{ICONS.clapperboard}</span>
              <span className="sidebar-title">{t.heading}</span>
            </span>
            <button className="sidebar-close-button" onClick={() => setIsSidebarOpen(false)} aria-label={t.closeMenuLabel}>
              ✕
            </button>
          </div>

          <div className="current-user-row">
            <span className="current-user-name">{currentUser.name}</span>
            <button className="logout-button" onClick={handleLogoutClick}>{t.logoutButton}</button>
          </div>

          <div className="manage-users-panel">
            <button className="import-export-button">{t.manageUsersButton}</button>
          </div>

          <button className="new-idea-button" onClick={handleAiMovieNewIdeaClick}>
            <span className="new-idea-icon">{ICONS.lightbulb}</span>
            {t.newIdeaButton}
          </button>

          <div className="import-export-row">
            <button className="import-export-button" onClick={() => aiMovieImportFileInputRef.current?.click()}>
              <span className="import-export-icon">{ICONS.upload}</span>
              {t.importButtonLabel}
            </button>
            <button
              className="import-export-button"
              onClick={handleAiMovieExportClick}
              disabled={!aiMovieProjectId || isExportingAiMovieProject}
            >
              <span className="import-export-icon">{ICONS.download}</span>
              {t.exportButtonLabel}
            </button>
          </div>
          <input
            type="file"
            accept="application/json"
            ref={aiMovieImportFileInputRef}
            onChange={handleAiMovieImportFileSelected}
            style={{ display: 'none' }}
          />

          <div className="sidebar-lang-toggle">
            <select
              className="lang-select"
              value={aiMovieLanguage}
              onChange={(e) => setAiMovieLanguage(e.target.value)}
            >
              <option value="en">English</option>
              <option value="hi">हिन्दी (Hindi)</option>
            </select>
          </div>

          <div className="sidebar-section">
            <h4 className="sidebar-section-title">{t.agentsSectionTitle}</h4>
            <div className="agent-list">
              <button
                className={aiMovieView === 'allProjects' ? 'agent-header active' : 'agent-header'}
                onClick={handleAiMovieAllProjectsClick}
              >
                <span className="agent-expand-icon">▸</span>
                {t.masterProjectListLabel}
              </button>
              {aiMovieProjectId && (
                <button
                  className={aiMovieView === 'reference' ? 'agent-header active' : 'agent-header'}
                  onClick={handleAiMovieReferenceViewClick}
                >
                  <span className="agent-expand-icon">▸</span>
                  {t.aiMovieReferenceHeading}
                </button>
              )}
              <button className="agent-header active">
                <span className="agent-expand-icon expanded">▸</span>
                {t.storyAgentLabel}
              </button>
              {aiMovieBackfillResult?.story && (
                <div className="stage-progress agent-substages">
                  {AI_MOVIE_STAGE_ORDER.map((stageKey) => {
                    const entry = aiMovieStageStatus[stageKey]
                    const current = getAiMovieCurrentStage(aiMovieStageStatus)
                    const dotStatus = entry?.status === 'approved' ? 'done' : current?.key === stageKey ? 'current' : 'upcoming'
                    const label =
                      stageKey === 'story' ? t.aiMovieStageLabelStory :
                      stageKey === 'synopsis' ? t.aiMovieStageLabelSynopsis :
                      stageKey === 'characterArc' ? t.aiMovieStageLabelCharacterArc :
                      stageKey === 'threeAct' ? t.aiMovieStageLabelThreeAct :
                      stageKey === 'plot' ? t.aiMovieStageLabelPlot :
                      t.aiMovieStageLabelScreenplay
                    return (
                      <button
                        key={stageKey}
                        className={`stage-progress-item stage-${dotStatus}${aiMovieView === 'editor' && shownAiMovieStage() === stageKey ? ' is-shown' : ''}`}
                        onClick={() => handleAiMovieStageClick(stageKey)}
                        aria-current={aiMovieView === 'editor' && shownAiMovieStage() === stageKey ? 'page' : undefined}
                      >
                        <span className="stage-progress-dot" />
                        {label}
                      </button>
                    )
                  })}
                </div>
              )}
              <button className="agent-header">
                <span className="agent-expand-icon">▸</span>
                {t.aiMovieProductionLabel}
              </button>
            </div>
          </div>

          <div className="sidebar-section">
            <h4 className="sidebar-section-title">{t.sidebarHistoryLabel}</h4>
            <p className="sidebar-section-note">{t.sidebarHistoryNote}</p>
            <div className="sidebar-history-item">{t.sidebarNewProject}</div>
          </div>
        </aside>

        <main className="chat-viewport">
          {aiMovieView === 'allProjects' && (
            <div className="concept-page" id="stage-master-list">
              <h2>{t.masterProjectListLabel}</h2>
              {isLoadingAiMovieProjects && <p className="sidebar-section-note">{t.loadingLabel}</p>}
              {!isLoadingAiMovieProjects && aiMovieProjectList.length === 0 && (
                <p className="sidebar-section-note">{t.sidebarHistoryNote}</p>
              )}
              <button
                type="button"
                className="choose-button ai-movie-generate-from-reference-button"
                onClick={handleSeedAkhadaProjectClick}
                disabled={isSeedingAkhadaProject}
              >
                {isSeedingAkhadaProject ? t.aiMovieSeedingAkhadaLabel : t.aiMovieSeedAkhadaButton}
              </button>
              <div className="master-list-grid">
                {aiMovieProjectList.map((project) => (
                  <div key={project.id} className="master-list-card">
                    <button className="master-list-card-open" onClick={() => loadAiMovieProject(project.id)}>
                      <strong>{project.title || project.pastedText?.slice(0, 40)}</strong>
                      <span className="breakdown-item-meta">{project.detectedStage}</span>
                    </button>
                    <div className="master-list-card-actions">
                      <button
                        className="sidebar-history-icon-button"
                        onClick={() => handleDeleteAiMovieProjectClick(project)}
                        title={t.aiMovieDeleteProjectButton}
                      >
                        {ICONS.trash}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {aiMovieView === 'editor' && (
          <div className="concept-page empty-state ai-movie-editor">
            {!aiMovieBackfillResult?.story && (
            <div className="format-picker">
              <p className="sidebar-section-note">{t.aiMovieAnalyzeIntro}</p>
              <textarea
                className="skip-ahead-textarea"
                value={aiMovieAnalyzeInput}
                onChange={(e) => setAiMovieAnalyzeInput(e.target.value)}
                placeholder={t.aiMovieAnalyzePlaceholder}
              />
              <button
                type="button"
                className="choose-button"
                onClick={handleAnalyzeAiMovieClick}
                disabled={isAnalyzingAiMovie || !aiMovieAnalyzeInput.trim()}
              >
                {isAnalyzingAiMovie ? t.aiMovieAnalyzingLabel : t.aiMovieAnalyzeButton}
              </button>

              {aiMovieAnalyzeError && <p className="feedback-note">{aiMovieAnalyzeError}</p>}

              {aiMovieAnalyzeStage && (
                <div className="ai-bubble">
                  <p>
                    {aiMovieAnalyzeStage === 'concept' && t.aiMovieStageResultConcept}
                    {aiMovieAnalyzeStage === 'story' && t.aiMovieStageResultStory}
                    {aiMovieAnalyzeStage === 'synopsis' && t.aiMovieStageResultSynopsis}
                    {aiMovieAnalyzeStage === 'bitsheet' && t.aiMovieStageResultBitsheet}
                    {aiMovieAnalyzeStage === 'screenplay' && t.aiMovieStageResultScreenplay}
                    {aiMovieAnalyzeStage === 'other' && t.aiMovieStageResultOther}
                  </p>
                  <button
                    type="button"
                    className="choose-button"
                    onClick={handleAiMovieProceedClick}
                    disabled={isBackfillingAiMovie}
                  >
                    {isBackfillingAiMovie ? t.aiMovieBackfillingLabel : t.aiMovieProceedButton}
                  </button>
                </div>
              )}

              {aiMovieBackfillError && <p className="feedback-note">{aiMovieBackfillError}</p>}
              {aiMovieBackfillNote && <p className="sidebar-section-note">{aiMovieBackfillNote}</p>}
            </div>
            )}

              {aiMovieBackfillResult && (
                <div className="concept-result">
                  {shownAiMovieStage() !== 'story' ? null : aiMovieBackfillResult.story && (() => {
                    const collapsed = isAiMovieStageCollapsed('story', true)
                    return (
                      <div className="three-act-structure" id="ai-movie-stage-story">
                        <button
                          type="button"
                          className="collapsible-stage-header"
                          onClick={() => toggleAiMovieStageExpanded('story', collapsed)}
                        >
                          <h3>{t.aiMovieStoryLayerHeading}</h3>
                          <span className="approved-badge">{t.approvedBadge}</span>
                          <span className="collapsible-caret">{collapsed ? '▸' : '▾'}</span>
                        </button>
                        {!collapsed && (
                          <>
                            <h4>{aiMovieBackfillResult.story.title[aiMovieLanguage]}</h4>
                            <p>{aiMovieBackfillResult.story.summary[aiMovieLanguage]}</p>
                          </>
                        )}
                      </div>
                    )
                  })()}

                  {aiMovieProjectTitle === 'Akhada' && !aiMovieStageStatus?.plot && (
                    <button
                      type="button"
                      className="choose-button ai-movie-generate-from-reference-button"
                      onClick={handleFillAkhadaStagesClick}
                      disabled={isFillingAkhadaStages}
                    >
                      {isFillingAkhadaStages ? t.aiMovieFillingAkhadaStagesLabel : t.aiMovieFillAkhadaStagesButton}
                    </button>
                  )}

                  {aiMovieProjectTitle === 'Akhada' && aiMovieStageStatus?.plot && shownAiMovieStage() === 'plot' && (
                    <>
                      <button
                        type="button"
                        className="choose-button ai-movie-generate-from-reference-button"
                        onClick={handleFillAkhadaBeatDurationsClick}
                        disabled={isFillingAkhadaBeatDurations}
                      >
                        {isFillingAkhadaBeatDurations ? t.aiMovieFillingBeatDurationsLabel : t.aiMovieFillBeatDurationsButton}
                      </button>
                      {aiMovieFillBeatDurationsNote && <p className="sidebar-section-note">{aiMovieFillBeatDurationsNote}</p>}
                    </>
                  )}

                  {(() => {
                    const current = getAiMovieCurrentStage(aiMovieStageStatus)
                    return AI_MOVIE_FORWARD_STAGES.filter((k) => k !== 'screenplay').map((stageKey) => {
                      const stageStatusEntry = aiMovieStageStatus[stageKey]
                      const content = aiMovieBackfillResult[stageKey]
                      const isCurrent = current?.key === stageKey
                      const isApproved = stageStatusEntry?.status === 'approved'
                      const stageLabel =
                        stageKey === 'synopsis' ? t.aiMovieStageLabelSynopsis :
                        stageKey === 'characterArc' ? t.aiMovieStageLabelCharacterArc :
                        stageKey === 'threeAct' ? t.aiMovieStageLabelThreeAct :
                        t.aiMovieStageLabelPlot

                      // Not reached yet — don't reveal it before its turn.
                      if (!isCurrent && !stageStatusEntry) return null
                      // Only the stage picked in the left menu is on screen.
                      if (shownAiMovieStage() !== stageKey) return null

                      const collapsed = isAiMovieStageCollapsed(stageKey, isApproved)

                      return (
                        <div key={stageKey} className="three-act-structure" id={`ai-movie-stage-${stageKey}`}>
                          <button
                            type="button"
                            className="collapsible-stage-header"
                            onClick={() => toggleAiMovieStageExpanded(stageKey, collapsed)}
                          >
                            <h3>{stageLabel}</h3>
                            {isApproved && <span className="approved-badge">{t.approvedBadge}</span>}
                            <span className="collapsible-caret">{collapsed ? '▸' : '▾'}</span>
                          </button>

                          {!collapsed && (
                            <>
                              {!content && isCurrent && current.mode === 'generate' && (
                                <button
                                  type="button"
                                  className="choose-button"
                                  onClick={() => handleGenerateAiMovieStageClick(stageKey)}
                                  disabled={isGeneratingAiMovieStage}
                                >
                                  {isGeneratingAiMovieStage ? t.aiMovieGeneratingStageLabel : t.aiMovieGenerateStageButton(stageLabel)}
                                </button>
                              )}

                              {content && stageKey === 'synopsis' && (
                                <>
                                  <p><em>{content.logline[aiMovieLanguage]}</em></p>
                                  <p>{content.premise[aiMovieLanguage]}</p>
                                  <p>{content.toneGenre[aiMovieLanguage]}</p>
                                  <p>{content.targetAudience[aiMovieLanguage]}</p>
                                </>
                              )}

                              {content && stageKey === 'threeAct' && content.map((act, index) => (
                                <div key={index} className="bit-row">
                                  <p className="bit-heading">{act.actName[aiMovieLanguage]}</p>
                                  <p>{act.description[aiMovieLanguage]}</p>
                                  <p><em>{t.aiMovieThreeActTurningPointLabel}:</em> {act.turningPoint[aiMovieLanguage]}</p>
                                </div>
                              ))}

                              {content && stageKey === 'plot' && content.map((beat, index) => (
                                <div key={index} className="bit-row">
                                  <p className="bit-heading">{beat.title[aiMovieLanguage]}</p>
                                  <p className="ai-movie-scene-duration">
                                    {t.aiMovieSceneDurationLabel(
                                      effectiveAiMovieBeatMinutes(beat, aiMovieBackfillResult?.screenplayBeats?.[index])
                                    )}
                                  </p>
                                  <p>{beat.description[aiMovieLanguage]}</p>
                                </div>
                              ))}

                              {content && stageKey === 'characterArc' && content.map((character, index) => (
                                <div key={index} className="character-card">
                                  <h4>{character.name}</h4>
                                  <p>{t.wantLabel}: {character.want[aiMovieLanguage]}</p>
                                  <p>{t.needLabel}: {character.need[aiMovieLanguage]}</p>
                                  <p>{t.arcLabel}: {character.arc[aiMovieLanguage]}</p>
                                </div>
                              ))}

                              {content && stageStatusEntry?.feedback && (
                                <p className="feedback-note">
                                  <strong>{t.changesRequestedBadge}</strong> "{stageStatusEntry.feedback}"
                                </p>
                              )}

                              {content && (
                                <div className="approval-section">
                                  {isApproved ? (
                                    <span className="approved-badge">{t.approvedBadge}</span>
                                  ) : (
                                    <>
                                      <div className="approval-buttons">
                                        <button
                                          className="approve-button"
                                          onClick={() => handleApproveAiMovieStageClick(stageKey)}
                                          disabled={isApprovingAiMovieStage}
                                        >
                                          {t.approveButton}
                                        </button>
                                        <button
                                          className="cancel-button"
                                          onClick={() => setShowAiMovieStageFeedbackForm(!showAiMovieStageFeedbackForm)}
                                        >
                                          {t.requestChangesButton}
                                        </button>
                                      </div>

                                      {showAiMovieStageFeedbackForm && (
                                        <div className="feedback-form">
                                          <textarea
                                            className="feedback-textarea"
                                            value={aiMovieStageFeedbackText}
                                            onChange={(e) => setAiMovieStageFeedbackText(e.target.value)}
                                            placeholder={t.feedbackPlaceholder}
                                          />
                                          <button
                                            className="choose-button"
                                            onClick={() => handleSubmitAiMovieStageFeedbackClick(stageKey)}
                                            disabled={isGeneratingAiMovieStage || !aiMovieStageFeedbackText.trim()}
                                          >
                                            {isGeneratingAiMovieStage ? t.submittingFeedback : t.submitFeedback}
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
                      )
                    })
                  })()}

                  {/* A stage picked in the menu that isn't open yet. */}
                  {(() => {
                    const shown = shownAiMovieStage()
                    const current = getAiMovieCurrentStage(aiMovieStageStatus)
                    const reached =
                      shown === 'story'
                        ? Boolean(aiMovieBackfillResult.story)
                        : shown === 'screenplay'
                          ? aiMovieStageStatus?.plot?.status === 'approved'
                          : Boolean(aiMovieStageStatus[shown]) || current?.key === shown
                    return reached ? null : <p className="sidebar-section-note ai-movie-stage-locked-note">{t.aiMovieStageNotOpenYetNote}</p>
                  })()}

                  {shownAiMovieStage() === 'screenplay' && aiMovieStageStatus?.plot?.status === 'approved' && (() => {
                    const screenplayBeats = aiMovieBackfillResult.screenplayBeats ?? []
                    const beatsPlot = aiMovieBackfillResult.plot ?? []
                    const screenplayApproved = aiMovieStageStatus?.screenplay?.status === 'approved'
                    const collapsed = isAiMovieStageCollapsed('screenplay', screenplayApproved)
                    const viewIndex = Math.min(aiMovieScreenplayViewIndex, Math.max(screenplayBeats.length - 1, 0))
                    const beat = screenplayBeats[viewIndex]
                    const beatMeta = beatsPlot[viewIndex]
                    // Real scripts number every scene in one running sequence
                    // across the whole film -- this beat's first scene
                    // continues from however many scenes all earlier beats hold.
                    const sceneNumberOffset = screenplayBeats
                      .slice(0, viewIndex)
                      .reduce((count, b) => count + (Array.isArray(b.scenes) ? b.scenes.length : 0), 0)

                    return (
                      <div className="three-act-structure" id="ai-movie-stage-screenplay">
                        <button
                          type="button"
                          className="collapsible-stage-header"
                          onClick={() => toggleAiMovieStageExpanded('screenplay', collapsed)}
                        >
                          <h3>{t.aiMovieStageLabelScreenplay}</h3>
                          {screenplayApproved && <span className="approved-badge">{t.approvedBadge}</span>}
                          <span className="collapsible-caret">{collapsed ? '▸' : '▾'}</span>
                        </button>

                        {!collapsed && (
                          <>
                            {screenplayBeats.length === 0 && (
                              <button
                                type="button"
                                className="choose-button"
                                onClick={handleGenerateAiMovieScreenplayClick}
                                disabled={isGeneratingAiMovieScreenplayBeat}
                              >
                                {isGeneratingAiMovieScreenplayBeat ? t.aiMovieScreenplayStartingLabel : t.aiMovieScreenplayGenerateButton}
                              </button>
                            )}

                            {screenplayApproved && (
                              <p className="sidebar-section-note">{t.aiMovieScreenplayAllApprovedNote}</p>
                            )}

                            {/* Whole-film, industry-format screenplay PDF, in whichever
                                language is currently being read. Shown as soon as any beat
                                has scenes -- it's a working draft, not only a final export. */}
                            {(() => {
                              const writtenBeatCount = screenplayBeats.filter((b) => Array.isArray(b.scenes) && b.scenes.length > 0).length
                              if (writtenBeatCount === 0) return null
                              const check = aiMovieBackfillResult.scriptCheck
                              const isRunning = check?.status === 'running'
                              const total = check?.beatIndexes?.length ?? 0
                              const report = Array.isArray(check?.report) ? check.report : []
                              const fixCount = report.reduce((n, r) => n + (r.fixes?.length ?? 0), 0)
                              const failed = report.filter((r) => r.error).length
                              return (
                                <div className={`script-check${isRunning ? ' is-running' : ''}`}>
                                  <div className="script-check-row">
                                    <button
                                      type="button"
                                      className="choose-button"
                                      onClick={() => handleStartAiMovieScriptCheckClick(writtenBeatCount)}
                                      disabled={isRunning}
                                    >
                                      {isRunning ? t.aiMovieScriptCheckRunningLabel(check.done, total) : t.aiMovieScriptCheckButton}
                                    </button>
                                    {!isRunning && check?.status === 'done' && (
                                      <button type="button" className="cancel-button" onClick={() => setShowAiMovieScriptCheckReport((v) => !v)}>
                                        {showAiMovieScriptCheckReport ? t.aiMovieScriptCheckHideReport : t.aiMovieScriptCheckShowReport(fixCount, report.length)}
                                      </button>
                                    )}
                                  </div>
                                  {isRunning && (
                                    <div className="script-check-progress" aria-hidden="true">
                                      <span style={{ width: `${total ? Math.round((check.done / total) * 100) : 0}%` }} />
                                    </div>
                                  )}
                                  <p className="script-check-note">
                                    {isRunning ? t.aiMovieScriptCheckRunningNote : check?.status === 'done' ? t.aiMovieScriptCheckDoneNote(check.finishedAt, failed) : t.aiMovieScriptCheckNote}
                                  </p>
                                  {aiMovieScriptCheckError && <p className="feedback-note">{aiMovieScriptCheckError}</p>}
                                  {showAiMovieScriptCheckReport && !isRunning && (
                                    <div className="script-check-report">
                                      {report.map((entry) => (
                                        <div key={entry.beat} className="script-check-report-beat">
                                          <p className="script-check-report-title">
                                            {t.aiMovieScriptCheckBeatLabel(entry.beat, beatsPlot[entry.beat - 1]?.title?.[aiMovieLanguage] || beatsPlot[entry.beat - 1]?.title?.en)}
                                          </p>
                                          {entry.error ? (
                                            <p className="feedback-note">{t.aiMovieScriptCheckBeatFailed}</p>
                                          ) : entry.fixes?.length ? (
                                            <ul>
                                              {entry.fixes.map((fix, i) => (
                                                <li key={i}>{fix.scene ? `${t.aiMovieScriptCheckSceneLabel(fix.scene)} — ` : ''}{fix.fix}</li>
                                              ))}
                                            </ul>
                                          ) : (
                                            <p className="script-check-note">{t.scriptEditNoFixesNote}</p>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )
                            })()}

                            {screenplayBeats.some((b) => Array.isArray(b.scenes) && b.scenes.length > 0) && (
                              <a
                                className="breakdown-pdf-link"
                                href={`${BACKEND_URL}/api/ai-movie/projects/${aiMovieProjectId}/screenplay.pdf?lang=${aiMovieLanguage}`}
                              >
                                {t.aiMovieScreenplayPdfButton(aiMovieLanguage)}
                              </a>
                            )}

                            {/* One beat's card at a time, navigated with Prev/Next rather than
                                a stacked list -- approving one auto-advances to the next, but
                                Prev/Next also lets you freely browse back to an already-approved
                                beat (it just shows read-only, badge and all) or ahead to
                                whatever's already sitting generated in the buffer. */}
                            {screenplayBeats.length > 0 && beat && (
                              <div className="ai-movie-screenplay-current-card">
                                <div className="ai-movie-screenplay-nav">
                                  <button
                                    type="button"
                                    className="ai-movie-screenplay-nav-button"
                                    onClick={() => {
                                      setAiMovieBeatTurnDirection('prev')
                                      setAiMovieScreenplayViewIndex((i) => Math.max(0, Math.min(i, screenplayBeats.length - 1) - 1))
                                    }}
                                    disabled={viewIndex === 0}
                                    aria-label="Previous beat"
                                  >
                                    ‹
                                  </button>
                                  <p className="bit-heading ai-movie-screenplay-nav-title">
                                    {t.aiMovieScreenplayBeatOfLabel(viewIndex + 1, screenplayBeats.length)}: {beatMeta?.title?.[aiMovieLanguage]}
                                    {beat.status === 'approved' && (
                                      <span className="approved-badge ai-movie-screenplay-nav-badge">{t.approvedBadge}</span>
                                    )}
                                  </p>
                                  <button
                                    type="button"
                                    className="ai-movie-screenplay-nav-button"
                                    onClick={() => {
                                      setAiMovieBeatTurnDirection('next')
                                      setAiMovieScreenplayViewIndex((i) => Math.min(screenplayBeats.length - 1, Math.min(i, screenplayBeats.length - 1) + 1))
                                    }}
                                    disabled={viewIndex === screenplayBeats.length - 1}
                                    aria-label="Next beat"
                                  >
                                    ›
                                  </button>
                                </div>

                                {(beat.status === 'not_started' || beat.status === 'generating') && (
                                  <p className="sidebar-section-note script-reel-note">{t.aiMovieScreenplayBeatWritingLabel}</p>
                                )}

                                {beat.status === 'error' && (
                                  <>
                                    <p className="feedback-note">{beat.feedback || t.aiMovieScreenplayBeatErrorLabel}</p>
                                    <button
                                      type="button"
                                      className="choose-button"
                                      onClick={() => handleRegenerateAiMovieScreenplayBeatClick(viewIndex, null)}
                                      disabled={isGeneratingAiMovieScreenplayBeat}
                                    >
                                      {isGeneratingAiMovieScreenplayBeat ? t.aiMovieGeneratingStageLabel : t.aiMovieScreenplayRetryButton}
                                    </button>
                                  </>
                                )}

                                {(beat.status === 'pending' || beat.status === 'approved') && (
                                  <>
                                    <RuntimeSummary
                                      total={
                                        beat.scenes &&
                                        beat.scenes.reduce((sum, scene) => sum + effectiveAiMovieSceneMinutes(scene), 0) + aiMovieSongMinutes(beat)
                                      }
                                      target={effectiveAiMovieBeatMinutes(beatMeta, beat)}
                                      t={t}
                                      label={t.aiMovieTotalRuntimeLabel}
                                      mismatchNote={(isShort) => (isShort ? t.aiMovieBeatShortNote : t.aiMovieBeatLongNote)}
                                    />

                                    {(() => {
                                      const target = beatMeta?.runtimeMinutes
                                      const total = (beat.scenes ?? []).reduce((sum, scene) => sum + effectiveAiMovieSceneMinutes(scene), 0) + aiMovieSongMinutes(beat)
                                      if (typeof target !== 'number' || total >= target * 0.9) return null
                                      return (
                                        <div className="ai-movie-extend-to-target">
                                          <button
                                            type="button"
                                            className="choose-button"
                                            onClick={() => handleExtendAiMovieScreenplayBeatClick(viewIndex)}
                                            disabled={isGeneratingAiMovieScreenplayBeat}
                                          >
                                            {isGeneratingAiMovieScreenplayBeat ? t.aiMovieExtendingToTargetLabel : t.aiMovieExtendToTargetButton(target)}
                                          </button>
                                          <p className="ai-movie-scene-duration">{t.aiMovieExtendToTargetNote}</p>
                                        </div>
                                      )
                                    })()}

                                    {beat.status === 'approved' && Array.isArray(beat.scenes) && beat.scenes.length > 0 && (
                                      <div className="ai-movie-beat-narration">
                                        <button
                                          type="button"
                                          className="cancel-button ai-movie-revise-scene-button"
                                          onClick={() => {
                                            setAiMovieNarrationBeatIndex(aiMovieNarrationBeatIndex === viewIndex ? null : viewIndex)
                                            setAiMovieNarrationError(null)
                                          }}
                                          disabled={isWritingAiMovieDialogue}
                                        >
                                          {aiMovieNarrationBeatIndex === viewIndex ? t.aiMovieDialogueCancelButton : t.aiMovieBeatNarrationButton}
                                        </button>
                                        {aiMovieNarrationBeatIndex === viewIndex && (
                                          <div className="feedback-form">
                                            <p className="ai-movie-scene-duration">{t.aiMovieBeatNarrationNote}</p>
                                            <textarea
                                              className="feedback-textarea"
                                              value={aiMovieNarrationText}
                                              onChange={(e) => setAiMovieNarrationText(e.target.value)}
                                              placeholder={t.aiMovieBeatNarrationPlaceholder}
                                            />
                                            <button
                                              type="button"
                                              className="choose-button"
                                              onClick={() => handleWriteAiMovieBeatNarrationClick(viewIndex, aiMovieNarrationText)}
                                              disabled={isWritingAiMovieDialogue || !aiMovieNarrationText.trim()}
                                            >
                                              {aiMovieNarrationProgress
                                                ? t.aiMovieBeatNarrationProgress(aiMovieNarrationProgress.scene, aiMovieNarrationProgress.total)
                                                : t.aiMovieBeatNarrationSubmitButton}
                                            </button>
                                            {aiMovieNarrationError && <p className="feedback-note">{aiMovieNarrationError}</p>}
                                          </div>
                                        )}
                                      </div>
                                    )}

                                    {Array.isArray(beat.scenes) && beat.scenes.length > 0 && (() => {
                                      // Step 2 of the redesign: scene list | script page | the
                                      // selected scene's tools, so the page itself stays clean.
                                      const sceneIndex = Math.min(aiMovieSelectedSceneIndex, beat.scenes.length - 1)
                                      const scene = beat.scenes[sceneIndex]
                                      const reviseKey = `${viewIndex}-${sceneIndex}`
                                      const isReviseFormOpen = aiMovieRevisingSceneIndex === reviseKey
                                      const isAiWriting = isWritingAiMovieDialogue || isRevisingAiMovieScreenplayScene || isGeneratingAiMovieScreenplayBeat || isSubmittingAiMovieSceneEdit
                                      return (
                                        <div className={`script-workspace${isAiWriting ? ' is-ai-writing' : ''}`}>
                                          <aside className="script-navigator" aria-label={t.scriptScenesTitle}>
                                            <p className="script-panel-title">{t.scriptScenesTitle}</p>
                                            <div className="script-navigator-list">
                                              {beat.scenes.map((navScene, navIndex) => (
                                                <button
                                                  key={navIndex}
                                                  type="button"
                                                  className={`script-nav-item${navIndex === sceneIndex ? ' is-active' : ''}`}
                                                  onClick={() => selectAiMovieScene(navIndex, true)}
                                                >
                                                  <span className="script-nav-number">{sceneNumberOffset + navIndex + 1}</span>
                                                  <span className="script-nav-heading">{navScene.sceneHeading?.en ?? ''}</span>
                                                  <span className="script-nav-duration">{t.aiMovieShortDuration(effectiveAiMovieSceneMinutes(navScene))}</span>
                                                </button>
                                              ))}
                                            </div>
                                          </aside>

                                          <div className="script-page-column">
                                            <div className="script-theme-switch" role="group" aria-label={t.scriptThemeLabel}>
                                        {['light', 'dark'].map((mode) => (
                                          <button
                                            key={mode}
                                            type="button"
                                            className={`script-theme-option${scriptTheme === mode ? ' is-active' : ''}`}
                                            onClick={() => changeScriptTheme(mode)}
                                          >
                                            {mode === 'light' ? t.scriptThemeLight : t.scriptThemeDark}
                                          </button>
                                        ))}
                                      </div>
                                            <div className="script-stage">
                                              <div
                                                key={`beat-${viewIndex}`}
                                                className={`script-page script-page-${scriptTheme} script-turn-${aiMovieBeatTurnDirection}`}
                                              >
                                                {beat.scenes.map((scene, sceneIndex) => aiMovieEditingScene?.key === `${viewIndex}-${sceneIndex}` ? (
                                                  renderAiMovieEditableScene(viewIndex, sceneIndex, sceneNumberOffset + sceneIndex + 1)
                                                ) : (
                                                  <div
                                                    key={sceneIndex}
                                                    id={`script-scene-${sceneIndex}`}
                                                    className={`script-scene${sceneIndex === Math.min(aiMovieSelectedSceneIndex, beat.scenes.length - 1) ? ' is-selected' : ''}`}
                                                    style={{ '--scene-order': sceneIndex }}
                                                    onClick={() => selectAiMovieScene(sceneIndex, false)}
                                                    onDoubleClick={() => !aiMovieEditingScene && startEditingAiMovieScene(viewIndex, sceneIndex, scene)}
                                                    title={t.scriptEditDoubleClickHint}
                                                  >
                                                    <p className="script-slug">
                                                      <span className="script-scene-number script-scene-number-left">{sceneNumberOffset + sceneIndex + 1}</span>
                                                      {scene.sceneHeading?.[aiMovieLanguage] ?? scene.sceneHeading?.en ?? ''}
                                                      <span className="script-scene-number script-scene-number-right">{sceneNumberOffset + sceneIndex + 1}</span>
                                                    </p>
                                          {Array.isArray(scene.content) && scene.content.length > 0 ? (
                                            scene.content.map((block, blockIndex) =>
                                              block.type === 'dialogue' ? (
                                                <div key={blockIndex} className="script-dialogue">
                                                  <p className="script-character">{aiMovieDialogueCharacterCue(scene.content, blockIndex)}</p>
                                                  {block.parenthetical?.en && (
                                                    <p className="script-parenthetical">
                                                      ({block.parenthetical[aiMovieLanguage] || block.parenthetical.en})
                                                    </p>
                                                  )}
                                                  <p className="script-line">{block.line?.[aiMovieLanguage] ?? block.line?.en ?? ''}</p>
                                                </div>
                                              ) : block.type === 'transition' ? (
                                                <p key={blockIndex} className="script-transition">{block.transition}</p>
                                              ) : (
                                                <p key={blockIndex} className="script-action">{block.text?.[aiMovieLanguage] ?? block.text?.en ?? ''}</p>
                                              )
                                            )
                                          ) : (
                                            <>
                                              <p className="script-action">{scene.action?.[aiMovieLanguage] ?? scene.action?.en ?? ''}</p>
                                              {Array.isArray(scene.dialogue) && scene.dialogue.map((line, lineIndex) => (
                                                <div key={lineIndex} className="script-dialogue">
                                                  <p className="script-character">{line.character}</p>
                                                  <p className="script-line">{line.line?.[aiMovieLanguage] ?? line.line?.en ?? ''}</p>
                                                </div>
                                              ))}
                                            </>
                                          )}
                                                  </div>
                                                ))}
                                              </div>
                                              {/* Rendered straight into <body> so no animated parent can
                                                  stop them covering the real screen edges. */}
                                              {createPortal(
                                                <div className={`script-letterbox-layer${isAiWriting ? ' is-ai-writing' : ''}`} aria-hidden="true">
                                                  <div className="script-letterbox script-letterbox-top" />
                                                  <div className="script-letterbox script-letterbox-bottom">
                                                    <span className="script-letterbox-label">{t.scriptAiWritingLabel}</span>
                                                  </div>
                                                </div>,
                                                document.body
                                              )}
                                            </div>
                                          </div>

                                          <aside className="script-tools" aria-label={t.scriptSelectedSceneTitle(sceneNumberOffset + sceneIndex + 1)}>
                                            <p className="script-panel-title">{t.scriptSelectedSceneTitle(sceneNumberOffset + sceneIndex + 1)}</p>
                                            <p className="script-tools-heading">{scene.sceneHeading?.[aiMovieLanguage] ?? scene.sceneHeading?.en ?? ''}</p>
                                            <div className="script-tools-meta" key={`meta-${viewIndex}-${sceneIndex}`}>
                                            <span>{t.aiMovieSceneDurationLabel(effectiveAiMovieSceneMinutes(scene))}</span>
                                            {scene.characters?.[aiMovieLanguage] && <span>{scene.characters[aiMovieLanguage]}</span>}
                                            {scene.card && (
                                              <span>
                                                {t.aiMovieScenePurposeLabels[scene.card.purpose] ?? scene.card.purpose}
                                                {' · '}
                                                {scene.card.emotion?.[aiMovieLanguage] || scene.card.emotion?.en} {scene.card.intensity}/10
                                                {' · '}
                                                {scene.card.turn?.[aiMovieLanguage] || scene.card.turn?.en}
                                              </span>
                                            )}
                                            </div>
                                            <div className="script-tools-actions">
                                              {aiMovieEditingScene?.key === reviseKey ? (
                                                <p className="script-tools-editing-note">{t.scriptEditEditingNote}</p>
                                              ) : (
                                                <button
                                                  type="button"
                                                  className="choose-button script-edit-start-button"
                                                  onClick={() => startEditingAiMovieScene(viewIndex, sceneIndex, scene)}
                                                  disabled={Boolean(aiMovieEditingScene) || isAiWriting}
                                                >
                                                  {t.scriptEditStartButton}
                                                </button>
                                              )}
                                              {aiMovieSceneEditFixes?.key === reviseKey && (
                                                <div className="script-edit-fixes">
                                                  <p className="script-panel-title">{t.scriptEditFixesTitle}</p>
                                                  {aiMovieSceneEditFixes.fixes.length === 0 ? (
                                                    <p>{t.scriptEditNoFixesNote}</p>
                                                  ) : (
                                                    <ul>
                                                      {aiMovieSceneEditFixes.fixes.map((fix, fixIndex) => <li key={fixIndex}>{fix}</li>)}
                                                    </ul>
                                                  )}
                                                </div>
                                              )}
                                          <button
                                            type="button"
                                            className="cancel-button ai-movie-revise-scene-button"
                                            onClick={() => {
                                              setAiMovieRevisingSceneIndex(isReviseFormOpen ? null : reviseKey)
                                              setAiMovieReviseSceneText('')
                                            }}
                                            disabled={isRevisingAiMovieScreenplayScene}
                                          >
                                            {isReviseFormOpen ? t.aiMovieReviseSceneCancelButton : t.aiMovieReviseSceneButton}
                                          </button>
                                          {isReviseFormOpen && (
                                            <div className="feedback-form">
                                              <textarea
                                                className="feedback-textarea"
                                                value={aiMovieReviseSceneText}
                                                onChange={(e) => setAiMovieReviseSceneText(e.target.value)}
                                                placeholder={t.aiMovieReviseScenePlaceholder}
                                              />
                                              <button
                                                type="button"
                                                className="choose-button"
                                                onClick={() => handleReviseAiMovieScreenplaySceneClick(viewIndex, sceneIndex, aiMovieReviseSceneText)}
                                                disabled={isRevisingAiMovieScreenplayScene}
                                              >
                                                {isRevisingAiMovieScreenplayScene ? t.aiMovieRevisingSceneLabel : t.aiMovieReviseSceneSubmitButton}
                                              </button>
                                            </div>
                                          )}

                                          {beat.status === 'approved' && (() => {
                                            const dialogueKey = `${viewIndex}-${sceneIndex}`
                                            const isDialogueFormOpen = aiMovieDialogueSceneIndex === dialogueKey
                                            const hasDialogueResult = Array.isArray(scene.content) || Array.isArray(scene.dialogue)
                                            const hasAnyDialogueLines = Array.isArray(scene.content)
                                              ? scene.content.some((block) => block.type === 'dialogue')
                                              : Array.isArray(scene.dialogue) && scene.dialogue.length > 0
                                            return (
                                              <>
                                                {hasDialogueResult && !hasAnyDialogueLines && (
                                                  <p className="ai-movie-scene-duration">{t.aiMovieNoDialogueNeededNote}</p>
                                                )}
                                                <button
                                                  type="button"
                                                  className="cancel-button ai-movie-revise-scene-button"
                                                  onClick={() => {
                                                    setAiMovieDialogueSceneIndex(isDialogueFormOpen ? null : dialogueKey)
                                                    setAiMovieDialogueInstructionText('')
                                                  }}
                                                  disabled={isWritingAiMovieDialogue}
                                                >
                                                  {isDialogueFormOpen
                                                    ? t.aiMovieDialogueCancelButton
                                                    : hasDialogueResult
                                                      ? t.aiMovieRewriteDialogueButton
                                                      : t.aiMovieWriteDialogueButton}
                                                </button>
                                                {isDialogueFormOpen && (
                                                  <div className="feedback-form">
                                                    <textarea
                                                      className="feedback-textarea"
                                                      value={aiMovieDialogueInstructionText}
                                                      onChange={(e) => setAiMovieDialogueInstructionText(e.target.value)}
                                                      placeholder={t.aiMovieDialoguePlaceholder}
                                                    />
                                                    <button
                                                      type="button"
                                                      className="choose-button"
                                                      onClick={() =>
                                                        handleWriteAiMovieDialogueClick(viewIndex, sceneIndex, aiMovieDialogueInstructionText)
                                                      }
                                                      disabled={isWritingAiMovieDialogue}
                                                    >
                                                      {isWritingAiMovieDialogue ? t.aiMovieWritingDialogueLabel : t.aiMovieDialogueSubmitButton}
                                                    </button>
                                                  </div>
                                                )}
                                                {aiMovieDialogueError?.key === dialogueKey && (
                                                  <p className="feedback-note">{aiMovieDialogueError.message}</p>
                                                )}
                                              </>
                                            )
                                          })()}
                                            </div>
                                          </aside>
                                        </div>
                                      )
                                    })()}

                                    {/* Song beats (the Beat Sheet says "song") get a song sheet:
                                        everything except the lyrics, which a real lyricist writes. */}
                                    {isAiMovieSongBeat(beatMeta) && Array.isArray(beat.scenes) && (
                                      <div className="ai-movie-song-sheet">
                                        {beat.song && (
                                          <>
                                            <p className="bit-heading">
                                              {t.aiMovieSongSheetLabel}: "{beat.song.workingTitle?.[aiMovieLanguage] || beat.song.workingTitle?.en}" · {t.aiMovieSceneDurationLabel(beat.song.durationMinutes)}
                                            </p>
                                            {[
                                              ['aiMovieSongSituationLabel', beat.song.situation],
                                              ['aiMovieSongPurposeLabel', beat.song.storyPurpose],
                                              ['aiMovieSongMoodLabel', beat.song.mood],
                                              ['aiMovieSongMusicLabel', beat.song.musicStyle],
                                              ['aiMovieSongSingersLabel', beat.song.singers],
                                              ['aiMovieSongLyricistBriefLabel', beat.song.lyricistBrief],
                                            ].map(([labelKey, value]) => (
                                              <p key={labelKey}>
                                                <strong>{t[labelKey]}:</strong> {value?.[aiMovieLanguage] || value?.en}
                                              </p>
                                            ))}
                                            <p><strong>{t.aiMovieSongPicturizationLabel}:</strong></p>
                                            {(beat.song.picturization ?? []).map((part, partIndex) => (
                                              <p key={partIndex} className="ai-movie-song-part">
                                                <strong>{part.section}</strong> — {part.visuals?.[aiMovieLanguage] || part.visuals?.en}
                                              </p>
                                            ))}
                                          </>
                                        )}
                                        <button
                                          type="button"
                                          className="ai-movie-revise-scene-button"
                                          onClick={() => handleWriteAiMovieSongSheetClick(viewIndex)}
                                          disabled={isWritingAiMovieSongSheet}
                                        >
                                          {isWritingAiMovieSongSheet
                                            ? t.aiMovieWritingSongSheetLabel
                                            : beat.song
                                              ? t.aiMovieRewriteSongSheetButton
                                              : t.aiMovieWriteSongSheetButton}
                                        </button>
                                      </div>
                                    )}

                                    {/* Script Doctor: per-beat review, nothing changes until the user
                                        clicks. Scene notes apply straight to that scene's Request
                                        Changes; whole-beat notes only pre-fill a box (a whole-beat
                                        rewrite replaces its scenes and dialogue). */}
                                    {Array.isArray(beat.scenes) && beat.scenes.length > 0 && (
                                      <div className="ai-movie-doctor">
                                        <button
                                          type="button"
                                          className="ai-movie-revise-scene-button"
                                          onClick={() => handleRunAiMovieScriptDoctorClick(viewIndex)}
                                          disabled={isRunningAiMovieScriptDoctor || isRevisingAiMovieScreenplayScene}
                                        >
                                          {isRunningAiMovieScriptDoctor
                                            ? t.aiMovieDoctorRunningLabel
                                            : beat.doctorNotes
                                              ? t.aiMovieDoctorRerunButton
                                              : t.aiMovieDoctorButton}
                                        </button>
                                        {beat.doctorNotes && beat.doctorNotes.notes.length === 0 && (
                                          <p className="ai-movie-scene-card">{t.aiMovieDoctorNoNotes}</p>
                                        )}
                                        {beat.doctorNotes?.notes.map((note, noteIndex) => {
                                          const currentSceneIndex = note.sceneNumber > 0 ? aiMovieDoctorNoteSceneIndex(beat.scenes, note) : null
                                          return (
                                            <div key={noteIndex} className={`ai-movie-doctor-note ai-movie-doctor-${note.severity}`}>
                                              <p className="ai-movie-doctor-note-title">
                                                {note.severity === 'major' ? t.aiMovieDoctorMajor : t.aiMovieDoctorMinor}
                                                {' · '}
                                                {note.sceneNumber > 0
                                                  ? t.aiMovieDoctorSceneLabel(sceneNumberOffset + (currentSceneIndex >= 0 ? currentSceneIndex : note.sceneNumber - 1) + 1)
                                                  : t.aiMovieDoctorWholeBeatLabel}
                                                {' · '}
                                                {t.aiMovieDoctorCategoryLabels[note.category] ?? note.category}
                                              </p>
                                              <p>{note.problem?.[aiMovieLanguage] || note.problem?.en}</p>
                                              <p><strong>{t.aiMovieDoctorFixLabel}:</strong> {note.fix?.[aiMovieLanguage] || note.fix?.en}</p>
                                              {note.applied ? (
                                                <p className="ai-movie-scene-card">{t.aiMovieDoctorAppliedLabel}</p>
                                              ) : note.sceneNumber > 0 ? (
                                                currentSceneIndex >= 0 ? (
                                                  <button
                                                    type="button"
                                                    className="ai-movie-revise-scene-button"
                                                    onClick={() => handleReviseAiMovieScreenplaySceneClick(viewIndex, currentSceneIndex, note.fix.en, noteIndex)}
                                                    disabled={isRevisingAiMovieScreenplayScene}
                                                  >
                                                    {isRevisingAiMovieScreenplayScene ? t.aiMovieDoctorApplyingLabel : t.aiMovieDoctorApplyButton}
                                                  </button>
                                                ) : (
                                                  <p className="ai-movie-scene-card">{t.aiMovieDoctorSceneChangedLabel}</p>
                                                )
                                              ) : (
                                                <button
                                                  type="button"
                                                  className="ai-movie-revise-scene-button"
                                                  onClick={() => setAiMovieDoctorBeatFixText(note.fix?.en ?? '')}
                                                >
                                                  {t.aiMovieDoctorUseInRequestChangesButton}
                                                </button>
                                              )}
                                            </div>
                                          )
                                        })}
                                        {aiMovieDoctorBeatFixText !== null && (
                                          <div className="feedback-form">
                                            <p className="feedback-note">{t.aiMovieDoctorWholeBeatWarning}</p>
                                            <textarea
                                              className="feedback-textarea"
                                              value={aiMovieDoctorBeatFixText}
                                              onChange={(e) => setAiMovieDoctorBeatFixText(e.target.value)}
                                            />
                                            <button
                                              className="choose-button"
                                              onClick={async () => {
                                                await handleRegenerateAiMovieScreenplayBeatClick(viewIndex, aiMovieDoctorBeatFixText)
                                                setAiMovieDoctorBeatFixText(null)
                                              }}
                                              disabled={isGeneratingAiMovieScreenplayBeat || !aiMovieDoctorBeatFixText.trim()}
                                            >
                                              {isGeneratingAiMovieScreenplayBeat ? t.submittingFeedback : t.submitFeedback}
                                            </button>
                                            <button type="button" className="cancel-button" onClick={() => setAiMovieDoctorBeatFixText(null)}>
                                              {t.aiMovieReviseSceneCancelButton}
                                            </button>
                                          </div>
                                        )}
                                      </div>
                                    )}

                                    {/* The INTERVAL is placed by hand (the user's choice), one per
                                        film -- placing it on another beat simply moves it. */}
                                    {aiMovieBackfillResult?.intervalAfterBeat === viewIndex ? (
                                      <div className="ai-movie-interval-marker">
                                        <span>{t.aiMovieIntervalMarker}</span>
                                        <button
                                          type="button"
                                          className="ai-movie-revise-scene-button"
                                          onClick={() => handleSetAiMovieIntervalClick(null)}
                                          disabled={isSavingAiMovieInterval}
                                        >
                                          {t.aiMovieRemoveIntervalButton}
                                        </button>
                                      </div>
                                    ) : (
                                      aiMovieIntervalAllowedAfterBeat(beatsPlot, viewIndex) && (
                                        <button
                                          type="button"
                                          className="ai-movie-revise-scene-button"
                                          onClick={() => handleSetAiMovieIntervalClick(viewIndex)}
                                          disabled={isSavingAiMovieInterval}
                                        >
                                          {t.aiMovieSetIntervalButton(Math.round(aiMovieMinutesAtEndOfBeat(beatsPlot, viewIndex)) || null)}
                                        </button>
                                      )
                                    )}

                                    {beat.feedback && (
                                      <p className="feedback-note">
                                        <strong>{t.changesRequestedBadge}</strong> "{beat.feedback}"
                                      </p>
                                    )}

                                    {beat.status === 'pending' && (
                                      <div className="approval-section">
                                        <div className="approval-buttons">
                                          <button
                                            className="approve-button"
                                            onClick={() => handleApproveAiMovieScreenplayBeatClick(viewIndex)}
                                            disabled={isApprovingAiMovieScreenplayBeat}
                                          >
                                            {t.approveButton}
                                          </button>
                                          <button
                                            className="cancel-button"
                                            onClick={() => setShowAiMovieScreenplayBeatFeedbackForm(!showAiMovieScreenplayBeatFeedbackForm)}
                                          >
                                            {t.requestChangesButton}
                                          </button>
                                        </div>

                                        {showAiMovieScreenplayBeatFeedbackForm && (
                                          <div className="feedback-form">
                                            <textarea
                                              className="feedback-textarea"
                                              value={aiMovieScreenplayBeatFeedbackText}
                                              onChange={(e) => setAiMovieScreenplayBeatFeedbackText(e.target.value)}
                                              placeholder={t.feedbackPlaceholder}
                                            />
                                            <button
                                              className="choose-button"
                                              onClick={() => handleRegenerateAiMovieScreenplayBeatClick(viewIndex, aiMovieScreenplayBeatFeedbackText)}
                                              disabled={isGeneratingAiMovieScreenplayBeat || !aiMovieScreenplayBeatFeedbackText.trim()}
                                            >
                                              {isGeneratingAiMovieScreenplayBeat ? t.submittingFeedback : t.submitFeedback}
                                            </button>
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )
                  })()}

                  {aiMovieStageError && <p className="feedback-note">{aiMovieStageError}</p>}
                  {!getAiMovieCurrentStage(aiMovieStageStatus) && (
                    <p className="sidebar-section-note">{t.aiMovieAllStagesLockedNote}</p>
                  )}
                </div>
              )}
            </div>
          )}

          {aiMovieView === 'reference' && (
          <div className="concept-page">
            <div className="format-picker">
              <h4 className="format-picker-title">{t.aiMovieReferenceHeading}</h4>
              <p className="sidebar-section-note">{t.aiMovieReferenceIntro}</p>

              <textarea
                className="skip-ahead-textarea"
                value={aiMovieReferenceText}
                onChange={(e) => setAiMovieReferenceText(e.target.value)}
                placeholder={t.aiMovieReferencePastePlaceholder}
              />

              <div className="import-export-row">
                <button
                  type="button"
                  className="choose-button"
                  onClick={handleAddAiMovieReferenceTextClick}
                  disabled={isAddingAiMovieReferenceText || !aiMovieReferenceText.trim()}
                >
                  {isAddingAiMovieReferenceText ? t.aiMovieReferenceAddingLabel : t.aiMovieReferenceAddButton}
                </button>
                <button
                  type="button"
                  className="import-export-button"
                  onClick={() => aiMovieReferenceFileInputRef.current?.click()}
                  disabled={isUploadingAiMovieReferenceFile}
                >
                  <span className="import-export-icon">{ICONS.upload}</span>
                  {isUploadingAiMovieReferenceFile ? t.aiMovieReferenceUploadingLabel : t.aiMovieReferenceUploadButton}
                </button>
              </div>
              <input
                type="file"
                accept=".pdf,.doc,.docx,.txt,.md,.markdown,.zip"
                multiple
                ref={aiMovieReferenceFileInputRef}
                onChange={handleAiMovieReferenceFileSelected}
                style={{ display: 'none' }}
              />

              {aiMovieReferenceError && <p className="feedback-note">{aiMovieReferenceError}</p>}

              {aiMovieReferenceFileList.length > 0 && !aiMovieAnalyzeInput.trim() && (
                <button
                  type="button"
                  className="choose-button ai-movie-generate-from-reference-button"
                  onClick={handleGenerateAiMovieFromReferenceClick}
                  disabled={isGeneratingAiMovieFromReference}
                >
                  {isGeneratingAiMovieFromReference ? t.aiMovieGeneratingFromReferenceLabel : t.aiMovieGenerateFromReferenceButton}
                </button>
              )}

              {aiMovieReferenceFileList.length === 0 ? (
                <p className="sidebar-section-note">{t.aiMovieReferenceEmptyNote}</p>
              ) : (
                aiMovieReferenceFileList.map((file) => (
                  <div key={file.id} className="ai-movie-reference-row">
                    <span className="ai-movie-reference-label">
                      [{file.category}] {file.label || t.aiMovieReferenceUntitledLabel}
                    </span>
                    <button
                      className="sidebar-history-icon-button"
                      onClick={() => handleDeleteAiMovieReferenceFileClick(file.id)}
                      title={t.aiMovieReferenceRemoveTitle}
                    >
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
          )}
        </main>
      </div>
    )
  }

  return (
    <DictationContext.Provider value={{ t, dictationLanguage, onDictationLanguageChange: handleDictationLanguageChange }}>
    <div className="app-shell">
      <FloatingAgentWidget
        currentUser={currentUser}
        t={t}
        onRunCompleted={() => loadProjectList()}
        onOpenProject={(id) => { setActiveAgent('story'); loadProject(id) }}
      />
      <div className="mobile-topbar">
        <button className="mobile-menu-button" onClick={() => setIsSidebarOpen(true)} aria-label={t.openMenuLabel}>
          ☰
        </button>
        <span className="mobile-topbar-title">{conceptId ? sidebarProjectLabel : t.heading}</span>
      </div>

      {isSidebarOpen && <div className="sidebar-overlay" onClick={() => setIsSidebarOpen(false)} />}

      <aside className={`sidebar ${isSidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-header">
          <button
            className="sidebar-home-button"
            onClick={handleGoHomeClick}
            disabled={isScopedToOneProject}
            aria-label={t.heading}
          >
            <span className="sidebar-logo">{ICONS.clapperboard}</span>
            <span className="sidebar-title">
              {conceptId ? (
                (() => {
                  const { main, sub } = splitProjectTitleForSidebar(sidebarProjectLabel)
                  return sub ? (
                    <>
                      <span className="sidebar-title-main">{main}</span>
                      <span className="sidebar-title-sub">{sub}</span>
                    </>
                  ) : (
                    main
                  )
                })()
              ) : (
                t.heading
              )}
            </span>
          </button>
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
                  <MicInput placeholder={t.crewNameLabel} value={newUserName} onChange={(e) => setNewUserName(e.target.value)} />
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

        <div className="sidebar-lang-toggle">
          <select
            className="lang-select"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
          >
            <option value="en">English</option>
            <option value="or">ଓଡ଼ିଆ (Odia)</option>
          </select>
        </div>

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
                <button className={`stage-progress-item stage-${stageIdea}${shownMovieStage === 'idea' ? ' is-shown' : ''}`} onClick={() => handleStageClick('stage-idea')}>
                  <span className="stage-progress-dot" />
                  {t.stageIdeaLabel}
                </button>
                <button className={`stage-progress-item stage-${stageSynopsis}${shownMovieStage === 'synopsis' ? ' is-shown' : ''}`} onClick={() => handleStageClick('stage-synopsis')}>
                  <span className="stage-progress-dot" />
                  {t.stageSynopsisLabel}
                </button>
                <button className={`stage-progress-item stage-${stageCharacters}${shownMovieStage === 'characters' ? ' is-shown' : ''}`} onClick={() => handleStageClick('stage-characters')}>
                  <span className="stage-progress-dot" />
                  {t.stageCharactersLabel}
                </button>
                <button className={`stage-progress-item stage-${stageBitSheet}${shownMovieStage === 'bitsheet' ? ' is-shown' : ''}`} onClick={() => handleStageClick('stage-bitsheet')}>
                  <span className="stage-progress-dot" />
                  {t.stageBitSheetLabel}
                </button>
                <button className={`stage-progress-item stage-${stageScreenplay}${shownMovieStage === 'screenplay' ? ' is-shown' : ''}`} onClick={() => handleStageClick('stage-screenplay')}>
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
              <div className="production-main-nav">
                <button className={`production-main-nav-item stage-${stageBreakdown}`} onClick={() => handleStageClick('stage-breakdown')}>
                  <span className="production-main-nav-icon">{ICONS.pencil}</span>
                  {t.stageBreakdownLabel}
                </button>
                <button className="production-main-nav-item stage-upcoming" onClick={() => handleStageClick('stage-crew')}>
                  <span className="production-main-nav-icon">{ICONS.users}</span>
                  {t.stageCrewLabel}
                </button>
                <button className={`production-main-nav-item stage-${stageSchedule}`} onClick={() => handleStageClick('stage-schedule')}>
                  <span className="production-main-nav-icon">{ICONS.calendar}</span>
                  {t.stageScheduleLabel}
                </button>
                <button className="production-main-nav-item stage-upcoming" onClick={() => setIsClapboardOpen(true)}>
                  <span className="production-main-nav-icon">{ICONS.calendar}</span>
                  {t.stageClapboardLabel}
                </button>
              </div>
            )}
          </div>
        </div>

        {currentUser.role === 'admin' && (
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
        )}

      </aside>

      <main className="chat-viewport">
    <div className={`concept-page${activeAgent === 'story' ? ' movie-editor' : ''}`} id="stage-idea">
      {errorMessage && <div className="error-banner">{errorMessage}</div>}
      {toastMessage && <div className="success-banner">{toastMessage}</div>}

      {activeAgent === 'masterList' && (
        <div className="three-act-structure" id="stage-master-list">
          <h2>{t.masterProjectListHeading}</h2>

          {selectedMasterProjectIds.size > 0 && (
            <button
              type="button"
              className="cancel-button master-list-bulk-delete-button"
              onClick={handleBulkDeleteMasterProjectsClick}
              disabled={isBulkDeletingProjects}
            >
              {isBulkDeletingProjects
                ? t.deletingSelectedProjectsButton
                : t.deleteSelectedProjectsButton(selectedMasterProjectIds.size)}
            </button>
          )}

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
                    <div key={project.id} className="master-list-card">
                      <button className="master-list-card-open" onClick={() => handleOpenMasterProjectClick(project)}>
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
                      <div className="master-list-card-actions">
                        {currentUser.role === 'admin' && (
                          <input
                            type="checkbox"
                            className="master-list-card-checkbox"
                            checked={selectedMasterProjectIds.has(project.id)}
                            onChange={() => toggleMasterProjectSelected(project.id)}
                            title={t.selectProjectCheckboxTitle}
                          />
                        )}
                        <button
                          className="sidebar-history-icon-button"
                          onClick={() => handleRenameMasterProjectClick(project)}
                          title={t.renameIconTitle}
                        >
                          {ICONS.pencil}
                        </button>
                        {currentUser.role === 'admin' && (
                          <button
                            className="sidebar-history-icon-button"
                            onClick={() => handleDeleteMasterProjectClick(project)}
                            title={t.deleteIconTitle}
                          >
                            {ICONS.trash}
                          </button>
                        )}
                      </div>
                    </div>
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
                    <div key={project.id} className="master-list-card">
                      <button className="master-list-card-open" onClick={() => handleOpenMasterProjectClick(project)}>
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
                      <div className="master-list-card-actions">
                        {currentUser.role === 'admin' && (
                          <input
                            type="checkbox"
                            className="master-list-card-checkbox"
                            checked={selectedMasterProjectIds.has(project.id)}
                            onChange={() => toggleMasterProjectSelected(project.id)}
                            title={t.selectProjectCheckboxTitle}
                          />
                        )}
                        <button
                          className="sidebar-history-icon-button"
                          onClick={() => handleRenameMasterProjectClick(project)}
                          title={t.renameIconTitle}
                        >
                          {ICONS.pencil}
                        </button>
                        {currentUser.role === 'admin' && (
                          <button
                            className="sidebar-history-icon-button"
                            onClick={() => handleDeleteMasterProjectClick(project)}
                            title={t.deleteIconTitle}
                          >
                            {ICONS.trash}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {activeAgent === 'story' && (
      <>
      {movieShows('idea') && !storylines && !(conceptId && projectType === 'story') && (
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
                <label className="format-radio">
                  <input
                    type="radio"
                    name="format"
                    value="vertical"
                    checked={formatType === 'vertical'}
                    onChange={() => {
                      setFormatType('vertical')
                      setEpisodeCount(60)
                      setEpisodeMinutes(1.5)
                    }}
                  />
                  {t.verticalDramaOption}
                </label>
              </div>

              {formatType === 'series' || formatType === 'vertical' ? (
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
                      min="0.1"
                      step="0.1"
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

          {startStage === 'idea' ? (
            <div className="skip-ahead-form">
              <div className="skip-ahead-textarea-wrap">
                <textarea
                  className="skip-ahead-textarea"
                  value={concept}
                  onChange={(e) => setConcept(e.target.value)}
                  placeholder={t.skipPastePlaceholderIdea}
                />
                <MicButton
                  t={t}
                  dictationLanguage={dictationLanguage}
                  onDictationLanguageChange={handleDictationLanguageChange}
                  wrapClassName="skip-ahead-mic-wrap"
                  className="skip-ahead-mic"
                  title={t.micButtonTitle}
                  listeningTitle={t.micButtonListeningTitle}
                  onResult={(text) => setConcept((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))}
                />
              </div>
              <div className="skip-ahead-controls">
                <button
                  className="choose-button"
                  onClick={handleGenerateClick}
                  disabled={isLoading || !concept.trim()}
                >
                  {isLoading ? t.skipContinueButtonLoading : t.generateIdeaButton}
                </button>
              </div>
            </div>
          ) : (
            <div className="skip-ahead-form">
              <div className="skip-ahead-textarea-wrap">
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
                <MicButton
                  t={t}
                  dictationLanguage={dictationLanguage}
                  onDictationLanguageChange={handleDictationLanguageChange}
                  wrapClassName="skip-ahead-mic-wrap"
                  className="skip-ahead-mic"
                  title={t.micButtonTitle}
                  listeningTitle={t.micButtonListeningTitle}
                  onResult={(text) => setSkipPastedText((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))}
                />
              </div>
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

      {movieShows('idea') && projectType === 'story' && (concept || storylines?.length > 0) && (
        <div className="ai-bubble">
          <p>{t.instruction}</p>
        </div>
      )}

      {movieShows('idea') && storylines?.length > 0 && (pendingStoryline || !pitchDeck) && (
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

      {movieShows('synopsis') && isGeneratingPitchDeck && (
        <div className="ai-bubble">
          <p>{t.buildingPitchDeck}</p>
          <AnalyzingProgressBar active={isGeneratingPitchDeck} label={t.buildingPitchDeck} estimatedSeconds={30} />
        </div>
      )}
      </>
      )}

      {activeAgent === 'story' && (
      <>
      {movieShows('synopsis') && pitchDeck && (
        <div className="pitch-deck" id="stage-synopsis">
          <span className="format-badge">{formatBadgeText(pitchDeck.format, t)}</span>
          <h2>{pitchDeck.title[language]}</h2>
          <p className="pitch-deck-logline"><em>{pitchDeck.logline[language]}</em></p>

          {pitchDeck.storyPages && pitchDeck.storyPages.length > 0 && (
            <div className="pitch-deck-story">
              <h4>{t.storyHeading}</h4>
              {pitchDeck.storyPages.map((page, index) => (
                <p key={index}>{page[language]}</p>
              ))}
            </div>
          )}

          <h4>{t.premise}</h4>
          <p>{pitchDeck.premise[language]}</p>

          <h4>{t.toneGenre}</h4>
          <p>{pitchDeck.toneGenre[language]}</p>

          <h4>{t.targetAudience}</h4>
          <p>{pitchDeck.targetAudience[language]}</p>

          {pitchDeck.highlights && pitchDeck.highlights.length > 0 && (
            <div className="pitch-deck-highlights">
              <h4>{t.highlightsHeading}</h4>
              <ul>
                {pitchDeck.highlights.map((highlight, index) => (
                  <li key={index}>{highlight[language]}</li>
                ))}
              </ul>
            </div>
          )}

          {pitchDeck.sponsorshipAngle && (
            <>
              <h4>{t.sponsorshipAngleHeading}</h4>
              <p>{pitchDeck.sponsorshipAngle[language]}</p>
            </>
          )}

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
                  {episode.hook && (
                    <p className="episode-hook"><strong>{t.hookLabel}:</strong> {episode.hook[language]}</p>
                  )}
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
                    <MicTextarea
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

          {pitchDeck.status === 'approved' && !characterSheet && (
            <p className="pitch-deck-download-hint">{t.pitchDeckDownloadHint}</p>
          )}

          {pitchDeck.status === 'approved' && characterSheet && (
            <DownloadChoiceButton
              t={t}
              label={t.exportAsPdf}
              className="export-button"
              pdfUrl={`${BACKEND_URL}/api/pitch-deck/${pitchDeck.id}/export?lang=${language}`}
              excelUrl={`${BACKEND_URL}/api/pitch-deck/${pitchDeck.id}/export-ppt?lang=${language}`}
              pdfLabel={t.downloadFormatPdf}
              excelLabel={t.downloadFormatPpt}
            />
          )}
        </div>
      )}

      {movieShows('characters') && pitchDeck && pitchDeck.status === 'approved' && !characterSheet && (
        <button
          className="choose-button generate-structure-button"
          onClick={handleGenerateCharacterSheetClick}
          disabled={isGeneratingCharacterSheet}
        >
          {isGeneratingCharacterSheet ? t.generatingCharacterSheetLabel : t.generateCharacterSheetButton}
        </button>
      )}
      <AnalyzingProgressBar active={isGeneratingCharacterSheet} label={t.generatingCharacterSheetLabel} estimatedSeconds={30} />

      {movieShows('characters') && characterSheet && (
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
                    <MicTextarea
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

      {movieShows('bitsheet') && characterSheet && characterSheet.status === 'approved' && !threeActStructure && (
        <button
          className="choose-button generate-structure-button"
          onClick={handleGenerateStructureClick}
          disabled={isGeneratingStructure}
        >
          {isGeneratingStructure ? t.generatingThreeAct : t.generateThreeAct}
        </button>
      )}
      <AnalyzingProgressBar active={isGeneratingStructure} label={t.generatingThreeAct} estimatedSeconds={30} />

      {movieShows('bitsheet') && threeActStructure && (
        <div className="three-act-structure">
          <h2>{t.threeActHeading}</h2>

          {threeActStructure.structureModel && (
            <p className="controlling-idea">
              <strong>{t.structureModelLabel}</strong> {t.structureModelNames[threeActStructure.structureModel] ?? threeActStructure.structureModel}
              {threeActStructure.structureReason ? ` — ${threeActStructure.structureReason}` : ''}
            </p>
          )}
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
                    <MicTextarea
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

      {movieShows('bitsheet') && threeActStructure && threeActStructure.status === 'locked' && !bitSheet && (
        <button
          className="choose-button generate-structure-button"
          onClick={handleGenerateBitSheetClick}
          disabled={isGeneratingBitSheet}
        >
          {isGeneratingBitSheet ? t.generatingBitSheet : t.generateBitSheet}
        </button>
      )}
      <AnalyzingProgressBar active={isGeneratingBitSheet} label={t.generatingBitSheet} estimatedSeconds={35} />

      {movieShows('bitsheet') && bitSheet && (
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
                    <MicTextarea
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

      {movieShows('screenplay') && bitSheet && bitSheet.status === 'approved' && !sceneList && (
        <button
          className="choose-button generate-structure-button"
          onClick={handleGenerateSceneListClick}
          disabled={isGeneratingSceneList}
        >
          {isGeneratingSceneList ? t.generatingSceneList : t.generateSceneList}
        </button>
      )}
      <AnalyzingProgressBar active={isGeneratingSceneList} label={t.generatingSceneList} estimatedSeconds={35} />

      {movieShows('screenplay') && sceneList && projectType === 'story' && (
        <div className="three-act-structure" id="stage-screenplay">
          <h2>{t.sceneListHeading}</h2>

          <MovieScreenplayWorkspace
            sceneList={sceneList}
            episodes={pitchDeck?.episodes}
            t={t}
            language={language}
            scriptTheme={scriptTheme}
            onChangeScriptTheme={changeScriptTheme}
            onSceneSaved={(key, scene) => setScreenplayScenesByKey((prev) => ({ ...prev, [key]: scene }))}
            onReloadScenes={() => loadScreenplayScenes(sceneList.id)}
            onSceneListChanged={applySceneListChange}
            screenplay={
              sceneList.status === 'approved'
                ? {
                    scenesByKey: screenplayScenesByKey,
                    generatingKey: generatingScreenplayKey,
                    feedbackFormKey: screenplayFeedbackFormKey,
                    feedbackTextByKey: screenplayFeedbackTextByKey,
                    submittingFeedbackKey: submittingScreenplayFeedbackKey,
                    dialogueLanguageByKey,
                    onDialogueLanguageChange: handleDialogueLanguageChange,
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
                    <MicTextarea
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
              <MicTextarea
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
              <AnalyzingProgressBar active={isImportingScreenplay || isImportingScreenplayFile} label={t.importingScreenplayLabel} estimatedSeconds={40} />
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
                  <MicTextarea
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
                  <AnalyzingProgressBar active={isReimportingScreenplay} label={t.reimportingScreenplayLabel} estimatedSeconds={40} />
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
          <MovieBreakdownFreshnessNote sceneListId={sceneList.id} t={t} />
          <h2>{t.scriptBreakdownHeading}</h2>

          {scriptBreakdown?.autoBackfillStatus === 'in_progress' && (
            <p className="auto-backfill-banner">{t.autoBackfillInProgressNote}</p>
          )}
          {scriptBreakdown?.autoBackfillStatus === 'retrying_after_failure' && (
            <p className="auto-backfill-banner retry">{t.autoBackfillRetryingNote}</p>
          )}

          {!scriptBreakdown && (
            <>
              <button
                className="choose-button generate-structure-button"
                onClick={handleGenerateBreakdownClick}
                disabled={isGeneratingBreakdown}
              >
                {isGeneratingBreakdown ? t.generatingBreakdownLabel : t.generateBreakdownButton}
              </button>
              {isGeneratingBreakdown && (
                <button className="cancel-button" onClick={handleCancelBreakdownPollClick}>
                  {t.cancelBreakdownButton}
                </button>
              )}
              <AnalyzingProgressBar active={isGeneratingBreakdown} label={t.generatingBreakdownLabel} estimatedSeconds={45} />
            </>
          )}

          {scriptBreakdown && (
            <>
              <div className="ad-sheet-panel">
                {canEditProduction && Boolean(sceneList.episodeScenes) && (
                  <button
                    className="breakdown-action-button"
                    onClick={handleClassifyEpisodeNumbersClick}
                    disabled={isClassifyingEpisodeNumbers}
                    title={t.classifyEpisodeNumbersHint}
                  >
                    {isClassifyingEpisodeNumbers ? t.classifyingEpisodeNumbersLabel : t.classifyEpisodeNumbersButton}
                  </button>
                )}
                <AnalyzingProgressBar active={isClassifyingEpisodeNumbers} label={t.classifyingEpisodeNumbersLabel} estimatedSeconds={30} />
                {canEditProduction && (
                  <button
                    className="breakdown-action-button"
                    onClick={handleGenerateAdSheetClick}
                    disabled={isGeneratingAdSheet}
                  >
                    {isGeneratingAdSheet ? t.generatingAdSheetLabel : t.generateAdSheetButton}
                  </button>
                )}
                {isGeneratingAdSheet && (
                  <button className="cancel-button" onClick={handleCancelBreakdownPollClick}>
                    {t.cancelBreakdownButton}
                  </button>
                )}
                <AnalyzingProgressBar active={isGeneratingAdSheet} label={t.generatingAdSheetLabel} estimatedSeconds={30} />
                {scriptBreakdown.adSheet && (
                  <DownloadChoiceButton
                    t={t}
                    label={t.downloadAdSheetLabel}
                    pdfUrl={`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/export-ad-sheet?lang=${language}`}
                    excelUrl={`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/export-ad-sheet-excel?lang=${language}`}
                  />
                )}
              </div>

              {renderBreakdownCategory('artistList', 'artistListHeading')}
              {renderBreakdownCategory('locationList', 'locationListHeading')}
              {renderBreakdownCategory('costumes', 'costumesHeading')}

              <div className="breakdown-merged-group">
                <div className="breakdown-merged-group-header">
                  <h4>{t.propsAndArtHeading}</h4>
                  <DownloadChoiceButton
                    t={t}
                    label={t.downloadLabel}
                    pdfUrl={`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/export?category=propsAndArt&lang=${language}`}
                    excelUrl={`${BACKEND_URL}/api/script-breakdown/${scriptBreakdown.id}/export-excel?category=propsAndArt&lang=${language}`}
                  />
                </div>
                {renderBreakdownCategory('props', 'propsHeading')}
                {renderBreakdownCategory('art', 'artHeading')}
              </div>

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
                          <MicTextarea
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

          <div className="crew-cast-group">
            <h3 className="crew-cast-group-heading">{t.crewGroupHeading}</h3>
            <CrewSection
              category="direction_team"
              heading={t.directionTeamHeading}
              members={crewMembers.filter((m) => m.category === 'direction_team')}
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
              category="production_team"
              heading={t.productionTeamHeading}
              members={crewMembers.filter((m) => m.category === 'production_team')}
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
              heading={t.otherCrewHeading}
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
        </div>
      )}

      {activeAgent === 'production' && scriptBreakdown && (
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
                <MicTextarea
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
                    <MicInput
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
                    <MicInput
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
              <AnalyzingProgressBar active={isGeneratingSchedule} label={t.generatingScheduleLabel} estimatedSeconds={35} />
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

              {canEditProduction &&
                shootSchedule.scheduleDays.some((day) => day.completed) &&
                shootSchedule.scheduleDays.some((day) => !day.completed) && (
                  <button
                    className="breakdown-action-button"
                    onClick={handlePrepareNextDaysClick}
                    disabled={isPreparingNextDays}
                  >
                    {isPreparingNextDays ? t.preparingNextDaysLabel : t.prepareNextDaysButton}
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

                    <div className="schedule-day-export-row">
                      <DownloadChoiceButton
                        t={t}
                        label={t.dayMasterBreakdownLabel}
                        pdfUrl={`${BACKEND_URL}/api/shoot-schedule/${shootSchedule.id}/export?day=${day.dayNumber}&lang=${language}`}
                        excelUrl={`${BACKEND_URL}/api/shoot-schedule/${shootSchedule.id}/export-excel?day=${day.dayNumber}&lang=${language}`}
                      />
                      <DownloadChoiceButton
                        t={t}
                        label={t.dayArtistBreakdownLabel}
                        pdfUrl={`${BACKEND_URL}/api/shoot-schedule/${shootSchedule.id}/export-day?day=${day.dayNumber}&category=artists&lang=${language}`}
                        excelUrl={`${BACKEND_URL}/api/shoot-schedule/${shootSchedule.id}/export-day-excel?day=${day.dayNumber}&category=artists&lang=${language}`}
                      />
                      <DownloadChoiceButton
                        t={t}
                        label={t.dayLocationBreakdownLabel}
                        pdfUrl={`${BACKEND_URL}/api/shoot-schedule/${shootSchedule.id}/export-day?day=${day.dayNumber}&category=locations&lang=${language}`}
                        excelUrl={`${BACKEND_URL}/api/shoot-schedule/${shootSchedule.id}/export-day-excel?day=${day.dayNumber}&category=locations&lang=${language}`}
                      />
                      <DownloadChoiceButton
                        t={t}
                        label={t.dayCostumeBreakdownLabel}
                        pdfUrl={`${BACKEND_URL}/api/shoot-schedule/${shootSchedule.id}/export-day?day=${day.dayNumber}&category=costumes&lang=${language}`}
                        excelUrl={`${BACKEND_URL}/api/shoot-schedule/${shootSchedule.id}/export-day-excel?day=${day.dayNumber}&category=costumes&lang=${language}`}
                      />
                      <DownloadChoiceButton
                        t={t}
                        label={t.dayPropertiesBreakdownLabel}
                        pdfUrl={`${BACKEND_URL}/api/shoot-schedule/${shootSchedule.id}/export-day?day=${day.dayNumber}&category=properties&lang=${language}`}
                        excelUrl={`${BACKEND_URL}/api/shoot-schedule/${shootSchedule.id}/export-day-excel?day=${day.dayNumber}&category=properties&lang=${language}`}
                      />
                      <DownloadChoiceButton
                        t={t}
                        label={t.dayCallSheetLabel}
                        pdfUrl={`${BACKEND_URL}/api/shoot-schedule/${shootSchedule.id}/call-sheet?day=${day.dayNumber}&lang=${language}`}
                        excelUrl={`${BACKEND_URL}/api/shoot-schedule/${shootSchedule.id}/call-sheet-excel?day=${day.dayNumber}&lang=${language}`}
                      />
                    </div>

                    {isDayExpanded && (
                      <>
                        {groupSceneRefsForDisplay(day.sceneRefs, sceneList, language).map((episodeGroup, epGroupIndex) => (
                          <div key={epGroupIndex} className="schedule-episode-group">
                            {episodeGroup.episodeIndex !== null && (
                              <h5 className="schedule-episode-header">
                                {t.episodeLabel} {episodeGroup.episodeIndex + 1}
                                <span className="breakdown-item-meta">
                                  {' '}
                                  ({episodeGroup.locationGroups.reduce((sum, g) => sum + g.items.length, 0)} {t.scenesLabel})
                                </span>
                              </h5>
                            )}
                            {episodeGroup.locationGroups.map((locationGroup, locGroupIndex) => (
                              <div key={locGroupIndex} className="schedule-location-group">
                                <h6 className="schedule-location-header">
                                  {locationGroup.location || t.unspecifiedLabel}{' '}
                                  <span className="breakdown-item-meta">({locationGroup.items.length} {t.scenesLabel})</span>
                                </h6>
                                <ul className="schedule-day-scenes">
                                  {locationGroup.items.map(({ ref, index, scene }) => {
                                    const isMarking = markingShotDayNumber === day.dayNumber
                                    const sceneKey = `${ref.episodeIndex ?? ''}-${ref.sceneIndex}`
                                    const isEditingScene = editingSceneKey === sceneKey
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
                                        {t.sceneLabel} {scene.sceneNumber ? cleanSceneNumber(scene.sceneNumber) : ref.sceneIndex + 1}: {scene.oneLiner[language]}
                                        {(() => {
                                          const sceneCast = lookupSceneCast(sceneList, scriptBreakdown?.adSheet, ref)
                                          return sceneCast?.length > 0 ? (
                                            <span className="schedule-scene-meta"> — {t.castCalledLabel}: {sceneCast.join(', ')}</span>
                                          ) : null
                                        })()}
                                        {!isEditingScene && (ref.costume || ref.properties) && (
                                          <span className="schedule-scene-meta">
                                            {ref.costume && ` — ${t.costumeLabel}: ${ref.costume}`}
                                            {ref.properties && ` — ${t.propertiesLabel}: ${ref.properties}`}
                                          </span>
                                        )}
                                        {!isEditingScene && ref.adRemark && (
                                          <p className="feedback-note schedule-scene-ad-remark">{t.adRemarkLabel}: {ref.adRemark}</p>
                                        )}
                                        {canEditProduction && !isEditingScene && (
                                          <button className="scene-edit-toggle" onClick={() => handleStartSceneEditClick(ref)}>
                                            {t.editSceneButton}
                                          </button>
                                        )}
                                        {isEditingScene && (
                                          <div className="scene-edit-form">
                                            <MicInput
                                              placeholder={t.costumeLabel}
                                              value={editSceneCostume}
                                              onChange={(e) => setEditSceneCostume(e.target.value)}
                                            />
                                            <MicInput
                                              placeholder={t.propertiesLabel}
                                              value={editSceneProperties}
                                              onChange={(e) => setEditSceneProperties(e.target.value)}
                                            />
                                            <MicInput
                                              placeholder={t.adRemarkLabel}
                                              value={editSceneAdRemark}
                                              onChange={(e) => setEditSceneAdRemark(e.target.value)}
                                            />
                                            <div className="scene-edit-form-actions">
                                              <button
                                                className="choose-button"
                                                onClick={() => handleSaveSceneEditClick(ref)}
                                                disabled={isSavingSceneEdit}
                                              >
                                                {isSavingSceneEdit ? t.savingLabel : t.saveButton}
                                              </button>
                                              <button
                                                className="cancel-button"
                                                onClick={() => setEditingSceneKey(null)}
                                                disabled={isSavingSceneEdit}
                                              >
                                                {t.cancelEditButton}
                                              </button>
                                            </div>
                                          </div>
                                        )}
                                      </li>
                                    )
                                  })}
                                </ul>
                              </div>
                            ))}
                          </div>
                        ))}
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
                              <MicTextarea
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
                              <AnalyzingProgressBar active={isParsingDayCompletion} label={t.parsingDayCompletionLabel} estimatedSeconds={15} />

                              {dayCompletionParseResult && (
                                <div className="reimport-changes-summary">
                                  <p><strong>{t.interpretedAsHeading}</strong></p>
                                  <p>✅ {t.completedLabel} ({dayCompletionParseResult.completed.length}): {dayCompletionParseResult.completed.map((c) => c.label.split(':')[0]).join(', ')}</p>
                                  <p>🔲 {t.movesToNextDayLabel} ({dayCompletionParseResult.notCompleted.length}): {dayCompletionParseResult.notCompleted.map((c) => c.label.split(':')[0]).join(', ') || t.noneLabel}</p>
                                  <p className="sidebar-section-note">{t.reviewCheckboxesNote}</p>
                                </div>
                              )}

                              <p className="availability-form-intro">{t.extraScenesReportIntro}</p>
                              <MicTextarea
                                className="skip-ahead-textarea"
                                value={extraSceneReportText}
                                onChange={(e) => setExtraSceneReportText(e.target.value)}
                                placeholder={t.extraScenesReportPlaceholder}
                              />

                              {dayCompletionParseResult?.extraMatches?.length > 0 && (
                                <div className="reimport-changes-summary">
                                  <p><strong>{t.extraScenesFoundHeading}</strong></p>
                                  <ul className="schedule-day-scenes">
                                    {dayCompletionParseResult.extraMatches.map((m) => {
                                      const key = `${m.dayNumber}-${m.index}`
                                      return (
                                        <li key={key}>
                                          <input
                                            type="checkbox"
                                            checked={extraSceneSelections[key] !== false}
                                            onChange={(e) =>
                                              setExtraSceneSelections((prev) => ({ ...prev, [key]: e.target.checked }))
                                            }
                                          />
                                          {m.label}
                                        </li>
                                      )
                                    })}
                                  </ul>
                                  <p className="sidebar-section-note">{t.reviewCheckboxesNote}</p>
                                </div>
                              )}

                              <MicTextarea
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
                                    setExtraSceneReportText('')
                                    setExtraSceneSelections({})
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
                              .map((d) => `${t.shootDayLabel} ${d.dayNumber}${d.date ? ` (${formatDisplayDate(d.date)})` : ''}${completedByDayNumber[d.dayNumber] ? ' ✓' : ''}`)
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
                          <MicTextarea
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

              <DownloadChoiceButton
                t={t}
                label={t.exportAsPdf}
                className="export-button"
                pdfUrl={`${BACKEND_URL}/api/shoot-schedule/${shootSchedule.id}/export?lang=${language}`}
                excelUrl={`${BACKEND_URL}/api/shoot-schedule/${shootSchedule.id}/export-excel?lang=${language}`}
              />
            </>
          )}
        </div>
      )}

    </div>
      </main>

      {(activeAgent === 'story'
        ? startStage === 'idea' || (conceptId && projectType === 'story')
        : Boolean(agentChatStageKey)) && (
        <aside className="chat-dock">
          {activeAgent === 'production' && agentChatStageKey ? (
            <AgentChatPanel
              t={t}
              BACKEND_URL={BACKEND_URL}
              conceptId={conceptId}
              stageKey={agentChatStageKey}
              currentUserName={currentUser?.name}
              onScheduleUpdated={setShootSchedule}
              onCastMemberUpdated={(castMember) =>
                setCrewMembers((prev) =>
                  prev.some((m) => m.id === castMember.id) ? prev.map((m) => (m.id === castMember.id ? castMember : m)) : [...prev, castMember]
                )
              }
              onBreakdownUpdated={setScriptBreakdown}
            />
          ) : (
            <ChangesChatPanel
              t={t}
              historyKey={`${conceptId ?? 'new'}:${barConfig.stageKey}`}
              barConfig={barConfig}
              isBusy={isBarBusy}
              errorMessage={errorMessage}
              currentUserName={currentUser?.name}
              openSignal={openChangesChatSignal}
              clearDraftHistorySignal={clearDraftHistorySignal}
              dictationLanguage={dictationLanguage}
              onDictationLanguageChange={handleDictationLanguageChange}
            />
          )}
        </aside>
      )}

      {isClapboardOpen && sceneList && (
        <ClapboardFullScreen
          t={t}
          BACKEND_URL={BACKEND_URL}
          conceptId={conceptId}
          sceneListId={sceneList.id}
          bannerUrl={clapboardBannerUrl}
          onBannerUpdated={setClapboardBannerUrl}
          canEditProduction={canEditProduction}
          sceneOptions={
            shootSchedule
              ? [...new Set(
                  (shootSchedule.scheduleDays ?? []).flatMap((day) =>
                    (day.sceneRefs ?? []).map((ref) => {
                      const scene = lookupScene(sceneList, ref)
                      const label = scene?.sceneNumber || String(ref.sceneIndex + 1)
                      return sceneList.episodeScenes ? `Ep${ref.episodeIndex + 1} Sc${label}` : `Sc${label}`
                    })
                  )
                )]
              : []
          }
          onClose={() => setIsClapboardOpen(false)}
        />
      )}
    </div>
    </DictationContext.Provider>
  )
}

export default App
