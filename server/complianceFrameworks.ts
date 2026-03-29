/**
 * Comprehensive FCC and IAB Compliance Frameworks
 * 
 * These are structured rule definitions used by the AI moderation and frame analysis
 * engines to assess advertising content against industry and regulatory standards.
 * 
 * Sources:
 * - FCC: 47 CFR Parts 73 & 76 (broadcast advertising rules)
 * - FTC: 16 CFR Part 255 (endorsements), Part 238 (bait advertising)
 * - IAB: Digital Advertising Guidelines, Ad Creative Guidelines, LEAN Principles
 * - NAD/CARU: Children's advertising guidelines
 * - TPBS: Television Bureau of Standards & Practices
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ComplianceRule {
  id: string;
  name: string;
  description: string;
  checkpoints: string[];
  severity: "info" | "warning" | "critical" | "blocking";
  applicableTo: ("video" | "image" | "audio" | "text" | "rich_media")[];
}

export interface ComplianceFramework {
  id: string;
  name: string;
  shortName: string;
  description: string;
  version: string;
  lastUpdated: string;
  categories: ComplianceCategory[];
}

export interface ComplianceCategory {
  id: string;
  name: string;
  description: string;
  weight: number; // 0-100 importance weight for scoring
  rules: ComplianceRule[];
}

export interface ComplianceScoreCategory {
  categoryId: string;
  categoryName: string;
  score: number; // 0-100
  maxScore: number;
  findings: ComplianceFinding[];
  status: "pass" | "warning" | "fail";
}

export interface ComplianceFinding {
  ruleId: string;
  ruleName: string;
  severity: "info" | "warning" | "critical" | "blocking";
  description: string;
  recommendation: string;
  confidence: number;
  frameTimestamp?: string; // For frame-level findings
}

// ─── FCC Compliance Framework ───────────────────────────────────────────────

export const FCC_FRAMEWORK: ComplianceFramework = {
  id: "fcc-broadcast-advertising",
  name: "FCC Broadcast Advertising Compliance",
  shortName: "FCC",
  description: "Federal Communications Commission rules governing broadcast advertising content, disclosures, and prohibited practices under 47 CFR Parts 73 and 76.",
  version: "2025.1",
  lastUpdated: "2025-01-15",
  categories: [
    {
      id: "fcc-content-standards",
      name: "Content Standards",
      description: "FCC rules on obscene, indecent, and profane content in broadcast advertising",
      weight: 25,
      rules: [
        {
          id: "fcc-cs-001",
          name: "Obscenity Prohibition",
          description: "18 U.S.C. § 1464 — Broadcast of obscene material is prohibited at all times. Material is obscene if: (1) the average person applying contemporary community standards would find the work appeals to prurient interest; (2) the work depicts or describes sexual conduct in a patently offensive way; (3) the work lacks serious literary, artistic, political, or scientific value.",
          checkpoints: [
            "Check for sexually explicit imagery or depictions",
            "Check for graphic sexual content or nudity shown in sexual context",
            "Check for content that appeals to prurient interest with no redeeming value",
            "Check for explicit depictions of sexual acts"
          ],
          severity: "blocking",
          applicableTo: ["video", "image", "rich_media"]
        },
        {
          id: "fcc-cs-002",
          name: "Indecency Safe Harbor",
          description: "47 CFR § 73.3999 — Indecent content (language or material that depicts sexual or excretory activities in a patently offensive manner) is restricted to 10:00 PM – 6:00 AM safe harbor. Ads must be evaluated for whether they could air outside safe harbor.",
          checkpoints: [
            "Check for language depicting sexual or excretory activities",
            "Check for material that could be considered patently offensive",
            "Check for partial nudity or suggestive imagery that goes beyond innuendo",
            "Assess whether content is suitable for daytime broadcast audiences including children"
          ],
          severity: "critical",
          applicableTo: ["video", "image", "audio", "text", "rich_media"]
        },
        {
          id: "fcc-cs-003",
          name: "Profanity Restrictions",
          description: "FCC enforcement against profane language in broadcast advertising. Includes George Carlin 'seven dirty words' standard and extensions.",
          checkpoints: [
            "Check for use of profane language in audio track or on-screen text",
            "Check for bleeped but obviously profane language",
            "Check for creative circumvention of profanity rules (letter substitutions, sound effects)",
            "Check for gestures widely understood as profane"
          ],
          severity: "critical",
          applicableTo: ["video", "audio", "text", "rich_media"]
        },
        {
          id: "fcc-cs-004",
          name: "Violence and Graphic Content",
          description: "While FCC has no explicit violence ban, broadcast Standards & Practices (S&P) departments typically reject ads with excessive violence, gore, or disturbing imagery as inconsistent with community standards.",
          checkpoints: [
            "Check for graphic depictions of violence, injury, or death",
            "Check for blood, gore, or mutilation",
            "Check for realistic weapons being used in threatening manner",
            "Check for content that could cause undue distress to general audiences",
            "Check for depictions of animal cruelty"
          ],
          severity: "critical",
          applicableTo: ["video", "image", "rich_media"]
        }
      ]
    },
    {
      id: "fcc-disclosure",
      name: "Disclosure & Transparency",
      description: "FCC rules on sponsorship identification, disclosures, and transparency in advertising",
      weight: 20,
      rules: [
        {
          id: "fcc-dt-001",
          name: "Sponsorship Identification",
          description: "47 CFR § 73.1212 — All broadcast advertising must clearly identify the sponsor. Paid content must include 'paid for by' or equivalent disclosure. Station identification must not be confused with sponsorship.",
          checkpoints: [
            "Check that sponsor/advertiser identity is clearly disclosed",
            "Check that paid content is identified as advertising/sponsored",
            "Check for adequate sponsor disclosure duration and legibility",
            "Check that content does not disguise advertising as editorial/news"
          ],
          severity: "warning",
          applicableTo: ["video", "audio", "text", "rich_media"]
        },
        {
          id: "fcc-dt-002",
          name: "Visual Disclosure Legibility",
          description: "FCC and FTC requirements that visual disclosures in ads must be clear, conspicuous, and readable. Text must be of sufficient size, duration, and contrast to be noticed and understood by consumers.",
          checkpoints: [
            "Check that fine print and disclaimers are readable (minimum font size relative to screen)",
            "Check that disclosures appear for adequate duration (generally 4+ seconds for text supers)",
            "Check for adequate contrast between text and background",
            "Check that important disclosures are not obscured by other visual elements",
            "Check that disclaimers use plain language understandable by general audience"
          ],
          severity: "warning",
          applicableTo: ["video", "image", "rich_media"]
        },
        {
          id: "fcc-dt-003",
          name: "Audio Disclosure Clarity",
          description: "Audio disclosures must be delivered at a reasonable pace and volume, not rushed or buried under music/sound effects.",
          checkpoints: [
            "Check that spoken disclaimers are at reasonable speed (not 'speed-read')",
            "Check that audio disclosures are at comparable volume to main ad",
            "Check that music/sound effects do not obscure required disclosures"
          ],
          severity: "warning",
          applicableTo: ["video", "audio"]
        },
        {
          id: "fcc-dt-004",
          name: "Political Advertising Disclosure",
          description: "47 CFR § 73.1212(e) — Political ads must include 'paid for by' and identify the sponsoring entity. Candidate ads must include candidate approval statement per BCRA.",
          checkpoints: [
            "Check if content is political in nature",
            "If political, verify 'paid for by' disclosure is present",
            "If candidate ad, verify candidate approval statement",
            "Check that political sponsor identity is accurate and complete"
          ],
          severity: "critical",
          applicableTo: ["video", "audio", "text", "rich_media"]
        }
      ]
    },
    {
      id: "fcc-prohibited-practices",
      name: "Prohibited Practices",
      description: "FCC-prohibited advertising practices and content categories",
      weight: 25,
      rules: [
        {
          id: "fcc-pp-001",
          name: "Subliminal Messaging",
          description: "FCC Public Notice (1974) — Subliminal techniques (embedding messages below conscious perception threshold) in broadcast advertising are prohibited and considered contrary to the public interest.",
          checkpoints: [
            "Check for single-frame or sub-threshold visual insertions",
            "Check for masked audio messages (backward masking, infrasonic)",
            "Check for flashing text/images at speeds too fast for conscious perception",
            "Check for embedded visual patterns designed for subconscious processing"
          ],
          severity: "blocking",
          applicableTo: ["video", "audio", "rich_media"]
        },
        {
          id: "fcc-pp-002",
          name: "Tobacco Advertising Ban",
          description: "15 U.S.C. § 1335 — Cigarette advertising is banned on broadcast media. Extended to smokeless tobacco (15 U.S.C. § 4402). E-cigarette advertising is restricted per FDA/FCC guidance.",
          checkpoints: [
            "Check for any tobacco product branding, logos, or imagery",
            "Check for cigarette, cigar, pipe, smokeless tobacco, or e-cigarette promotion",
            "Check for imagery that could be construed as tobacco endorsement",
            "Check for vaping/e-cigarette product placement or promotion"
          ],
          severity: "blocking",
          applicableTo: ["video", "image", "audio", "text", "rich_media"]
        },
        {
          id: "fcc-pp-003",
          name: "Lottery and Gambling Restrictions",
          description: "18 U.S.C. § 1304 — Broadcasting lottery information is restricted. Exceptions exist for state lotteries and certain casinos. Casino/gambling ads must comply with state-specific broadcast rules.",
          checkpoints: [
            "Check for promotion of illegal gambling or lotteries",
            "Check for gambling content targeting minors",
            "Check that gambling ads include responsible gambling disclosures",
            "Check that lottery/casino ads comply with jurisdictional rules"
          ],
          severity: "critical",
          applicableTo: ["video", "audio", "text", "rich_media"]
        },
        {
          id: "fcc-pp-004",
          name: "Hoax and False Emergency",
          description: "47 CFR § 73.1217 — Broadcasting false or misleading distress signals, crime reports, or emergency alerts is prohibited. Ads must not simulate emergency alert tones (EAS/EBS) or suggest false emergencies.",
          checkpoints: [
            "Check for use of Emergency Alert System (EAS) tones or similar sounds",
            "Check for simulated emergency broadcasts or news alerts",
            "Check for content that could cause public panic or false alarm",
            "Check for fake 'breaking news' or 'urgent alert' framing"
          ],
          severity: "blocking",
          applicableTo: ["video", "audio", "rich_media"]
        },
        {
          id: "fcc-pp-005",
          name: "CALM Act Compliance (Loudness)",
          description: "47 CFR § 76.607 — Commercial Advertisement Loudness Mitigation Act requires commercials to have same average loudness as surrounding programming. Measured via ATSC A/85 standard.",
          checkpoints: [
            "Check for sudden volume spikes in audio",
            "Check for excessively loud audio relative to normal speaking levels",
            "Note if audio levels appear significantly louder than normal broadcast content"
          ],
          severity: "warning",
          applicableTo: ["video", "audio"]
        }
      ]
    },
    {
      id: "fcc-children",
      name: "Children's Advertising Protections",
      description: "FCC rules protecting children from advertising exploitation, per Children's Television Act (CTA) and FCC implementation",
      weight: 20,
      rules: [
        {
          id: "fcc-ch-001",
          name: "Children's Program Ad Limits",
          description: "47 CFR § 73.670 — Commercial time in children's programming is limited to 10.5 minutes/hour on weekends and 12 minutes/hour on weekdays. Ads in children's programs have stricter content requirements.",
          checkpoints: [
            "Check if ad is intended for children's programming blocks",
            "If so, verify content is appropriate for child audiences",
            "Check for age-inappropriate themes, imagery, or language",
            "Check ad length compliance with children's program limits"
          ],
          severity: "critical",
          applicableTo: ["video", "audio", "rich_media"]
        },
        {
          id: "fcc-ch-002",
          name: "Host Selling / Program-Length Commercials",
          description: "47 CFR § 73.670 — In children's programming, program hosts/characters may not sell products during or adjacent to the program they appear in. Entire programs cannot be designed as commercials.",
          checkpoints: [
            "Check for children's TV characters used as product endorsers",
            "Check for blurring of program content and advertising aimed at children",
            "Check for interactive elements that direct children to purchase products"
          ],
          severity: "critical",
          applicableTo: ["video", "rich_media"]
        },
        {
          id: "fcc-ch-003",
          name: "COPPA Compliance",
          description: "Children's Online Privacy Protection Act considerations for digital/interactive advertising. Ads must not collect personal information from children under 13 without parental consent.",
          checkpoints: [
            "Check for data collection prompts aimed at children (enter your name, email, etc.)",
            "Check for QR codes or URLs directing children to data-collecting sites",
            "Check for interactive elements that could capture child data"
          ],
          severity: "critical",
          applicableTo: ["video", "image", "rich_media"]
        }
      ]
    },
    {
      id: "fcc-product-specific",
      name: "Product-Specific Regulations",
      description: "FCC and FTC rules governing advertising of specific product categories",
      weight: 10,
      rules: [
        {
          id: "fcc-ps-001",
          name: "Alcohol Advertising Guidelines",
          description: "While not FCC-banned, broadcast alcohol ads must follow voluntary industry codes (Distilled Spirits Council, Beer Institute). No targeting minors, no promoting excessive consumption, no linking alcohol to social/sexual success.",
          checkpoints: [
            "Check for alcohol ad content targeting persons under 21",
            "Check for depictions of excessive or irresponsible drinking",
            "Check for claims linking alcohol to social, sexual, or athletic success",
            "Check for 'drink responsibly' or equivalent disclosure presence",
            "Check for depictions of drinking while driving or operating machinery"
          ],
          severity: "warning",
          applicableTo: ["video", "image", "audio", "text", "rich_media"]
        },
        {
          id: "fcc-ps-002",
          name: "Pharmaceutical / DTC Drug Advertising",
          description: "FDA-regulated Direct-to-Consumer pharmaceutical ads must include fair balance of risk/benefit information, major side effects, and 'Ask your doctor' guidance. Must reference full prescribing information.",
          checkpoints: [
            "Check for adequate risk/benefit fair balance in drug advertising",
            "Check that major side effects are clearly disclosed",
            "Check for misleading efficacy claims without substantiation",
            "Check for adequate reference to prescribing information",
            "Check that DTC ads do not minimize serious risks"
          ],
          severity: "critical",
          applicableTo: ["video", "audio", "text", "rich_media"]
        },
        {
          id: "fcc-ps-003",
          name: "Financial Product Disclosures",
          description: "Truth in Lending Act (TILA), SEC, and FINRA requirements for financial product advertising. APR disclosures, risk statements, FDIC/SIPC notices must be clear and conspicuous.",
          checkpoints: [
            "Check that interest rates and APR are properly disclosed",
            "Check that investment risk disclaimers are present and legible",
            "Check for misleading income or return claims",
            "Check for required regulatory disclosures (FDIC, SIPC, NMLS)",
            "Check that 'past performance' disclaimers accompany return claims"
          ],
          severity: "critical",
          applicableTo: ["video", "image", "audio", "text", "rich_media"]
        }
      ]
    }
  ]
};

// ─── IAB Compliance Framework ───────────────────────────────────────────────

export const IAB_FRAMEWORK: ComplianceFramework = {
  id: "iab-advertising-guidelines",
  name: "IAB Advertising Standards & Guidelines",
  shortName: "IAB",
  description: "Interactive Advertising Bureau standards including Ad Creative Guidelines, LEAN Principles, Brand Safety guidelines, and Digital Video Ad Standards (VAST/VPAID compliance).",
  version: "2025.1",
  lastUpdated: "2025-02-01",
  categories: [
    {
      id: "iab-content-taxonomy",
      name: "Content Taxonomy & Classification",
      description: "IAB Content Taxonomy v3.0 classification and brand safety tier assignments per IAB Brand Safety guidelines",
      weight: 20,
      rules: [
        {
          id: "iab-ct-001",
          name: "Content Category Classification",
          description: "Ads must be classifiable under IAB Content Taxonomy v3.0 categories. Content that falls outside recognized categories or spans multiple sensitive categories requires enhanced review.",
          checkpoints: [
            "Classify ad content under IAB Content Taxonomy v3.0 tier-1 and tier-2 categories",
            "Flag content spanning multiple sensitive categories (e.g., politics + health + children)",
            "Identify primary and secondary content categories for targeting validation"
          ],
          severity: "info",
          applicableTo: ["video", "image", "audio", "text", "rich_media"]
        },
        {
          id: "iab-ct-002",
          name: "Brand Safety Floor (GARM Categories)",
          description: "Per GARM (Global Alliance for Responsible Media) Brand Safety Floor framework, certain content categories are universally unsuitable for advertising: arms/ammunition, online piracy, hate speech, obscenity/extreme profanity, illegal drugs/tobacco, spam/malware, terrorism, deplatformed/debunked content.",
          checkpoints: [
            "Check for content in GARM Brand Safety Floor 'excluded' categories",
            "Check for arms, ammunition, or weapons sales promotion",
            "Check for content promoting illegal drugs or drug paraphernalia",
            "Check for hate speech, slurs, or discriminatory content",
            "Check for content associated with terrorism or violent extremism",
            "Check for content promoting piracy or illegal downloads",
            "Check for spam indicators or malware distribution signals"
          ],
          severity: "blocking",
          applicableTo: ["video", "image", "audio", "text", "rich_media"]
        },
        {
          id: "iab-ct-003",
          name: "Brand Suitability Tiers",
          description: "GARM Brand Suitability Framework tier classification. Content is rated across risk dimensions: low (suitable), medium (context-dependent), high (unsuitable for most brands). Advertisers set tier thresholds per campaign.",
          checkpoints: [
            "Assess content against GARM risk tier for adult content",
            "Assess content against GARM risk tier for debated sensitive social issues",
            "Assess content against GARM risk tier for explicit violence/gore",
            "Assess content against GARM risk tier for illegal or borderline content",
            "Assess content against GARM risk tier for misinformation",
            "Assign overall GARM suitability tier (low/medium/high risk)"
          ],
          severity: "warning",
          applicableTo: ["video", "image", "audio", "text", "rich_media"]
        }
      ]
    },
    {
      id: "iab-creative-standards",
      name: "Ad Creative Technical Standards",
      description: "IAB New Ad Portfolio and Digital Video Ad guidelines for creative quality, format compliance, and user experience",
      weight: 15,
      rules: [
        {
          id: "iab-ac-001",
          name: "Ad Creative Quality",
          description: "IAB Ad Creative Guidelines require ads to be professionally produced, clearly branded, and not misleading in appearance. Ads should not mimic system notifications, error messages, or operating system UI elements.",
          checkpoints: [
            "Check that ad is professionally produced and not amateurish/spammy in appearance",
            "Check for fake 'close' buttons, system notification mimicry, or OS UI spoofing",
            "Check for misleading countdown timers or urgency indicators",
            "Check for fake virus/malware warnings used as clickbait",
            "Check for deceptive interactive elements (fake cursors, fake video players)"
          ],
          severity: "critical",
          applicableTo: ["video", "image", "rich_media"]
        },
        {
          id: "iab-ac-002",
          name: "LEAN Principles Compliance",
          description: "IAB LEAN (Light, Encrypted, AdChoices-supporting, Non-invasive) principles. Ads should respect user experience, not be overly intrusive, and support user control.",
          checkpoints: [
            "Check that ad does not autoplay audio without user initiation",
            "Check for excessively intrusive animation or flashing",
            "Check for content that could trigger photosensitive seizures (rapid flashing >3Hz)",
            "Check that ad provides clear user controls (skip, mute, close)",
            "Check that ad does not expand or resize without user interaction"
          ],
          severity: "warning",
          applicableTo: ["video", "image", "rich_media"]
        },
        {
          id: "iab-ac-003",
          name: "Video Ad Standards (VAST/VPAID)",
          description: "IAB VAST 4.2 and VPAID 2.0 compliance for digital video ads. Linear video ads should include proper companion ads, clickthrough URLs, progress tracking, and skip offset handling.",
          checkpoints: [
            "Check that video ad has clear beginning and end",
            "Check for proper branding throughout the video",
            "Check that clickable/interactive elements are clearly delineated",
            "Check that video quality meets minimum resolution standards",
            "Check for proper aspect ratio (16:9, 9:16, 1:1, 4:5)"
          ],
          severity: "info",
          applicableTo: ["video"]
        }
      ]
    },
    {
      id: "iab-truthfulness",
      name: "Truthfulness & Non-Deception",
      description: "IAB and FTC-aligned standards for truthful, non-deceptive advertising claims in digital media",
      weight: 25,
      rules: [
        {
          id: "iab-tn-001",
          name: "Truthful Claims & Substantiation",
          description: "FTC Act § 5 and IAB guidelines: All advertising claims must be truthful, not misleading, and substantiated. 'Puffery' (obvious exaggeration no reasonable consumer would take literally) is permitted; specific factual claims require evidence.",
          checkpoints: [
            "Check for specific factual claims (numbers, percentages, rankings) that require substantiation",
            "Check for before/after comparisons that may be misleading",
            "Check for testimonials that imply atypical results without disclosure",
            "Check for superlative claims ('best', '#1', 'fastest') that require substantiation",
            "Check for visual demonstrations that accurately represent product performance"
          ],
          severity: "critical",
          applicableTo: ["video", "image", "audio", "text", "rich_media"]
        },
        {
          id: "iab-tn-002",
          name: "Endorsement & Testimonial Disclosure",
          description: "16 CFR Part 255 (FTC Endorsement Guides): Material connections between endorsers and advertisers must be clearly disclosed. Includes influencer marketing, paid testimonials, employee endorsements, and gifted product reviews.",
          checkpoints: [
            "Check for celebrity or influencer endorsements without disclosure",
            "Check for 'real customer' testimonials that may be fabricated or paid",
            "Check for expert endorsements where expertise is not genuine",
            "Check for 'as seen on' or media mentions that are paid placements",
            "Check for proper '#ad', 'sponsored', or 'paid partnership' disclosure"
          ],
          severity: "critical",
          applicableTo: ["video", "image", "audio", "text", "rich_media"]
        },
        {
          id: "iab-tn-003",
          name: "Native Advertising Disclosure",
          description: "FTC Native Advertising Guidelines and IAB Native Advertising Playbook: Ads that match the form and function of surrounding content must be clearly and prominently labeled as advertising.",
          checkpoints: [
            "Check if ad is designed to look like editorial/organic content",
            "If native format, check for prominent 'Ad', 'Sponsored', or 'Promoted' label",
            "Check that disclosure is in same language as the ad",
            "Check that disclosure placement is immediately visible (not hidden or delayed)"
          ],
          severity: "warning",
          applicableTo: ["video", "image", "text", "rich_media"]
        },
        {
          id: "iab-tn-004",
          name: "Price and Offer Transparency",
          description: "Advertising must clearly represent pricing, terms of offers, and conditions. Bait-and-switch tactics, hidden fees, drip pricing, and artificially inflated 'original' prices are prohibited.",
          checkpoints: [
            "Check for hidden fees or conditions not clearly disclosed",
            "Check for misleading 'free' claims with undisclosed obligations",
            "Check for artificial urgency ('only 3 left!', 'offer ends today!') that may be false",
            "Check for unclear subscription terms or auto-renewal conditions",
            "Check for inflated 'original price' or misleading discount percentages"
          ],
          severity: "critical",
          applicableTo: ["video", "image", "audio", "text", "rich_media"]
        }
      ]
    },
    {
      id: "iab-privacy-data",
      name: "Privacy & Data Practices",
      description: "IAB privacy framework, GDPR/CCPA advertising requirements, and TCF compliance",
      weight: 15,
      rules: [
        {
          id: "iab-pd-001",
          name: "Data Collection Transparency",
          description: "IAB Transparency & Consent Framework (TCF 2.2) and privacy regulations require that ads clearly disclose data collection practices. Ads must not collect data without user awareness.",
          checkpoints: [
            "Check for forms or data entry fields requesting personal information",
            "Check that privacy policy is referenced or accessible",
            "Check for tracking pixel or fingerprinting indicators in ad creative",
            "Check that data collection purposes are clearly stated"
          ],
          severity: "warning",
          applicableTo: ["video", "image", "rich_media"]
        },
        {
          id: "iab-pd-002",
          name: "Sensitive Category Targeting",
          description: "IAB and NAI guidelines restrict targeting based on sensitive categories including health conditions, financial status, sexual orientation, political affiliation, religious beliefs, and racial/ethnic origin.",
          checkpoints: [
            "Check if ad creative reveals sensitive targeting (health conditions, financial distress)",
            "Check for content that implies knowledge of user's sensitive personal information",
            "Check that retargeting is not based on sensitive health or financial browsing",
            "Check for 'we know you have [condition]' type messaging"
          ],
          severity: "critical",
          applicableTo: ["video", "image", "audio", "text", "rich_media"]
        }
      ]
    },
    {
      id: "iab-accessibility",
      name: "Accessibility & Inclusivity",
      description: "IAB and WCAG-aligned accessibility standards for advertising content",
      weight: 10,
      rules: [
        {
          id: "iab-ai-001",
          name: "Visual Accessibility",
          description: "Ad content should meet WCAG 2.1 AA minimum contrast ratios. Text overlays should be readable against backgrounds. Critical information should not be conveyed by color alone.",
          checkpoints: [
            "Check text contrast ratio against background (minimum 4.5:1 for normal text, 3:1 for large text)",
            "Check that critical information is not conveyed solely through color",
            "Check for adequate text size for readability",
            "Check that text overlays have sufficient background contrast or shadow"
          ],
          severity: "info",
          applicableTo: ["video", "image", "rich_media"]
        },
        {
          id: "iab-ai-002",
          name: "Photosensitivity Safety",
          description: "WCAG 2.3.1 and Ofcom/ITU guidelines: Content must not contain flashing elements exceeding 3 flashes per second, or covering more than 25% of screen area. Red flashing is particularly dangerous.",
          checkpoints: [
            "Check for rapid flashing or strobing effects (>3 per second)",
            "Check for large-area brightness changes that could trigger seizures",
            "Check for rapid red color transitions",
            "Check for patterns known to trigger photosensitive epilepsy"
          ],
          severity: "critical",
          applicableTo: ["video", "rich_media"]
        },
        {
          id: "iab-ai-003",
          name: "Inclusive Representation",
          description: "IAB and advertiser best practices for avoiding harmful stereotypes, discriminatory imagery, and exclusionary representation in advertising.",
          checkpoints: [
            "Check for harmful racial, gender, or cultural stereotypes",
            "Check for discriminatory imagery or messaging",
            "Check for content that demeans or marginalizes protected groups",
            "Check for ageist, ableist, or otherwise exclusionary content"
          ],
          severity: "warning",
          applicableTo: ["video", "image", "audio", "text", "rich_media"]
        }
      ]
    },
    {
      id: "iab-sector-specific",
      name: "Sector-Specific Standards",
      description: "IAB guidelines for specific advertising verticals including health, finance, crypto, cannabis, and gambling",
      weight: 15,
      rules: [
        {
          id: "iab-ss-001",
          name: "Health & Wellness Claims",
          description: "FTC Health Advertising enforcement and IAB health category guidelines. Health-related claims must be substantiated by competent and reliable scientific evidence. Miracle cure claims and disease-prevention claims without FDA approval are prohibited.",
          checkpoints: [
            "Check for unsubstantiated health or medical claims",
            "Check for 'miracle cure', 'guaranteed results', or 'doctor approved' without evidence",
            "Check for weight loss claims that promise specific results without disclaimer",
            "Check for supplement claims that imply drug-like effects",
            "Check for anti-aging claims that are not substantiated",
            "Check for 'FDA approved' claims that are not accurate"
          ],
          severity: "critical",
          applicableTo: ["video", "image", "audio", "text", "rich_media"]
        },
        {
          id: "iab-ss-002",
          name: "Cryptocurrency & Digital Asset Advertising",
          description: "IAB and regulatory guidance on cryptocurrency and digital asset advertising. Crypto ads must include risk disclaimers, not guarantee returns, and comply with SEC/CFTC guidance.",
          checkpoints: [
            "Check for guaranteed investment return claims",
            "Check for missing risk disclaimers ('crypto is volatile', 'you may lose your investment')",
            "Check for misleading yield or APY claims",
            "Check for unregistered securities promotion",
            "Check for FOMO-inducing urgency tactics around crypto investments"
          ],
          severity: "critical",
          applicableTo: ["video", "image", "audio", "text", "rich_media"]
        },
        {
          id: "iab-ss-003",
          name: "Real Money Gaming / Gambling",
          description: "IAB and state-by-state gambling advertising requirements. Gambling ads must include responsible gaming messaging, age restrictions, and comply with jurisdictional rules.",
          checkpoints: [
            "Check for gambling ads targeting minors or young adults",
            "Check for missing responsible gaming disclosures",
            "Check for misleading odds or guaranteed winning claims",
            "Check for glamorization of gambling without risk acknowledgment",
            "Check for missing age verification or 21+ indicators"
          ],
          severity: "critical",
          applicableTo: ["video", "image", "audio", "text", "rich_media"]
        },
        {
          id: "iab-ss-004",
          name: "Cannabis / CBD Advertising",
          description: "State-specific and IAB guidance on cannabis/CBD advertising. Federal illegality creates patchwork rules. Most platforms restrict cannabis ads. CBD ads must not make medical claims.",
          checkpoints: [
            "Check for cannabis product advertising compliance with applicable state law",
            "Check for medical claims about CBD products without FDA approval",
            "Check for cannabis ads targeting minors",
            "Check for images of cannabis consumption that could normalize use for minors"
          ],
          severity: "critical",
          applicableTo: ["video", "image", "audio", "text", "rich_media"]
        }
      ]
    }
  ]
};

// ─── Compliance Prompt Generators ───────────────────────────────────────────

/**
 * Generates a comprehensive prompt section for AI moderation that includes
 * all FCC and IAB rules, formatted for LLM consumption.
 */
export function generateCompliancePrompt(frameworks: ComplianceFramework[]): string {
  let prompt = "REGULATORY & INDUSTRY COMPLIANCE FRAMEWORKS TO ASSESS AGAINST:\n\n";

  for (const fw of frameworks) {
    prompt += `═══ ${fw.name} (${fw.shortName}) ═══\n`;
    prompt += `${fw.description}\n\n`;

    for (const cat of fw.categories) {
      prompt += `── ${cat.name} (Weight: ${cat.weight}/100) ──\n`;
      for (const rule of cat.rules) {
        prompt += `  [${rule.id}] ${rule.name} (${rule.severity.toUpperCase()})\n`;
        prompt += `    ${rule.description}\n`;
        prompt += `    Checkpoints:\n`;
        for (const cp of rule.checkpoints) {
          prompt += `      • ${cp}\n`;
        }
        prompt += `\n`;
      }
    }
    prompt += `\n`;
  }

  return prompt;
}

/**
 * Generates a compact prompt for frame-level analysis — category names, rule IDs,
 * and one-line descriptions only. Saves ~40KB per LLM call vs the full prompt.
 */
export function generateCompactCompliancePrompt(frameworks: ComplianceFramework[]): string {
  let prompt = "COMPLIANCE RULES (flag violations by rule ID):\n";
  for (const fw of frameworks) {
    prompt += `\n[${fw.shortName}]\n`;
    for (const cat of fw.categories) {
      prompt += `${cat.name}:\n`;
      for (const rule of cat.rules) {
        prompt += `  ${rule.id} (${rule.severity}): ${rule.name}\n`;
      }
    }
  }
  return prompt;
}

/**
 * Generates the JSON schema for structured compliance scoring output.
 */
export function getComplianceScoringSchema() {
  return {
    type: "object" as const,
    properties: {
      complianceScores: {
        type: "array" as const,
        description: "Scores per compliance category",
        items: {
          type: "object" as const,
          properties: {
            categoryId: { type: "string" as const, description: "ID of the compliance category" },
            categoryName: { type: "string" as const, description: "Display name of the compliance category" },
            framework: { type: "string" as const, description: "FCC or IAB" },
            score: { type: "integer" as const, description: "Compliance score 0-100 for this category" },
            status: { type: "string" as const, enum: ["pass", "warning", "fail"] as const },
            findings: {
              type: "array" as const,
              items: {
                type: "object" as const,
                properties: {
                  ruleId: { type: "string" as const, description: "Rule ID from the compliance framework" },
                  ruleName: { type: "string" as const },
                  severity: { type: "string" as const, enum: ["info", "warning", "critical", "blocking"] as const },
                  description: { type: "string" as const, description: "Specific finding description" },
                  recommendation: { type: "string" as const, description: "Actionable recommendation to fix this issue" },
                  confidence: { type: "integer" as const, description: "Confidence in this finding 0-100" }
                },
                required: ["ruleId", "ruleName", "severity", "description", "recommendation", "confidence"] as const,
                additionalProperties: false as const
              }
            }
          },
          required: ["categoryId", "categoryName", "framework", "score", "status", "findings"] as const,
          additionalProperties: false as const
        }
      },
      overallFccScore: { type: "integer" as const, description: "Weighted aggregate FCC compliance score 0-100" },
      overallIabScore: { type: "integer" as const, description: "Weighted aggregate IAB compliance score 0-100" },
      complianceSummary: { type: "string" as const, description: "Executive summary of compliance assessment" },
      highestRiskArea: { type: "string" as const, description: "The single most concerning compliance area" },
      requiredActions: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "Prioritized list of required actions before this ad can air/publish"
      }
    },
    required: ["complianceScores", "overallFccScore", "overallIabScore", "complianceSummary", "highestRiskArea", "requiredActions"] as const,
    additionalProperties: false as const
  };
}

/**
 * Returns the list of all compliance category IDs and names for
 * building the frontend scoring display.
 */
export function getComplianceCategoryList(): { id: string; name: string; framework: string; weight: number }[] {
  const categories: { id: string; name: string; framework: string; weight: number }[] = [];

  for (const cat of FCC_FRAMEWORK.categories) {
    categories.push({ id: cat.id, name: cat.name, framework: "FCC", weight: cat.weight });
  }
  for (const cat of IAB_FRAMEWORK.categories) {
    categories.push({ id: cat.id, name: cat.name, framework: "IAB", weight: cat.weight });
  }

  return categories;
}

/**
 * Returns default policy seed data for creating built-in FCC and IAB policies in the database.
 */
export function getDefaultPolicySeedData(): {
  name: string;
  description: string;
  category: "content_standards" | "brand_safety" | "legal_compliance" | "industry_specific" | "platform_rules" | "custom";
  complianceFramework: string;
  rules: any;
  severity: "info" | "warning" | "critical" | "blocking";
  isTemplate: boolean;
}[] {
  const seeds = [];

  for (const cat of FCC_FRAMEWORK.categories) {
    seeds.push({
      name: `[FCC] ${cat.name}`,
      description: cat.description,
      category: "legal_compliance" as const,
      complianceFramework: "FCC",
      rules: { categoryId: cat.id, rules: cat.rules.map(r => ({ id: r.id, name: r.name, severity: r.severity, checkpoints: r.checkpoints })) },
      severity: cat.rules.some(r => r.severity === "blocking") ? "blocking" as const
        : cat.rules.some(r => r.severity === "critical") ? "critical" as const
        : "warning" as const,
      isTemplate: true,
    });
  }

  for (const cat of IAB_FRAMEWORK.categories) {
    seeds.push({
      name: `[IAB] ${cat.name}`,
      description: cat.description,
      category: "brand_safety" as const,
      complianceFramework: "IAB",
      rules: { categoryId: cat.id, rules: cat.rules.map(r => ({ id: r.id, name: r.name, severity: r.severity, checkpoints: r.checkpoints })) },
      severity: cat.rules.some(r => r.severity === "blocking") ? "blocking" as const
        : cat.rules.some(r => r.severity === "critical") ? "critical" as const
        : "warning" as const,
      isTemplate: true,
    });
  }

  return seeds;
}
