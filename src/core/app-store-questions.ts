// Apple's App Store compliance questions, shared by the CLI and the desktop
// questionnaire. Plain data with no Node dependencies, so the sandboxed
// renderer can import it.

export const LEVEL_QUESTIONS = {
  violenceCartoonOrFantasy: "Cartoon or fantasy violence",
  violenceRealistic: "Realistic violence",
  violenceRealisticProlongedGraphicOrSadistic:
    "Prolonged, graphic or sadistic realistic violence",
  gunsOrOtherWeapons: "Guns or other weapons",
  profanityOrCrudeHumor: "Profanity or crude humor",
  horrorOrFearThemes: "Horror or fear themes",
  matureOrSuggestiveThemes: "Mature or suggestive themes",
  sexualContentOrNudity: "Sexual content or nudity",
  sexualContentGraphicAndNudity: "Graphic sexual content and nudity",
  alcoholTobaccoOrDrugUseOrReferences:
    "Alcohol, tobacco or drug use or references",
  medicalOrTreatmentInformation: "Medical or treatment information",
  gamblingSimulated: "Simulated gambling",
  contests: "Contests",
} as const;

export const YES_NO_QUESTIONS = {
  gambling: "Real-money gambling",
  lootBox: "Loot boxes or other paid random items",
  advertising: "Advertising",
  userGeneratedContent: "User-generated content",
  messagingAndChat: "Messaging and chat between users",
  socialMedia: "Social media features",
  unrestrictedWebAccess: "Unrestricted web access",
  healthOrWellnessTopics: "Health or wellness topics",
  parentalControls: "Parental controls",
  ageAssurance: "Age assurance (verifying users' ages)",
} as const;

/** Apple's App Privacy data types, grouped as App Store Connect shows them. */
export const DATA_TYPES: Record<string, Record<string, string>> = {
  "Contact info": {
    NAME: "Name",
    EMAIL_ADDRESS: "Email address",
    PHONE_NUMBER: "Phone number",
    PHYSICAL_ADDRESS: "Physical address",
    OTHER_CONTACT_INFO: "Other contact info",
  },
  "Health & fitness": { HEALTH: "Health", FITNESS: "Fitness" },
  Financial: {
    PAYMENT_INFORMATION: "Payment info",
    CREDIT_AND_FRAUD: "Credit info",
    OTHER_FINANCIAL_INFO: "Other financial info",
  },
  Location: {
    PRECISE_LOCATION: "Precise location",
    COARSE_LOCATION: "Coarse location",
  },
  "Sensitive info": { SENSITIVE_INFO: "Sensitive info" },
  Contacts: { CONTACTS: "Contacts" },
  "User content": {
    EMAILS_OR_TEXT_MESSAGES: "Emails or text messages",
    PHOTOS_OR_VIDEOS: "Photos or videos",
    AUDIO: "Audio data",
    GAMEPLAY_CONTENT: "Gameplay content",
    CUSTOMER_SUPPORT: "Customer support",
    OTHER_USER_CONTENT: "Other user content",
  },
  "Browsing history": { BROWSING_HISTORY: "Browsing history" },
  "Search history": { SEARCH_HISTORY: "Search history" },
  Identifiers: { USER_ID: "User ID", DEVICE_ID: "Device ID" },
  Purchases: { PURCHASE_HISTORY: "Purchase history" },
  "Usage data": {
    PRODUCT_INTERACTION: "Product interaction",
    ADVERTISING_DATA: "Advertising data",
    OTHER_USAGE_DATA: "Other usage data",
  },
  Diagnostics: {
    CRASH_DATA: "Crash data",
    PERFORMANCE_DATA: "Performance data",
    OTHER_DIAGNOSTIC_DATA: "Other diagnostic data",
  },
  "Other data": { OTHER_DATA: "Other data types" },
};

export const PURPOSES = {
  THIRD_PARTY_ADVERTISING: "Third-party advertising",
  DEVELOPERS_ADVERTISING: "Developer's advertising or marketing",
  ANALYTICS: "Analytics",
  PRODUCT_PERSONALIZATION: "Product personalization",
  APP_FUNCTIONALITY: "App functionality",
  OTHER_PURPOSES: "Other purposes",
} as const;
