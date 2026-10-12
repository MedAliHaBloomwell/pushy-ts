/** How urgently a notification should interrupt the user (iOS 15+). */
export const InterruptionLevel = {
  PASSIVE: "passive",
  ACTIVE: "active",
  TIME_SENSITIVE: "time-sensitive",
  CRITICAL: "critical",
} as const;

export type InterruptionLevel = (typeof InterruptionLevel)[keyof typeof InterruptionLevel];

/** The kind of update a Live Activity notification carries. */
export const LiveActivityEvent = {
  START: "start",
  UPDATE: "update",
  END: "end",
} as const;

export type LiveActivityEvent = (typeof LiveActivityEvent)[keyof typeof LiveActivityEvent];

export const DEFAULT_SOUND_FILENAME = "default";

type JsonObject = Record<string, unknown>;

const APS_KEY = "aps";

const epochSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

/**
 * Builds APNs payloads (JSON strings) for push notifications. A port of Pushy's `ApnsPayloadBuilder`.
 *
 * @see https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification
 */
export class ApnsPayloadBuilder {
  private alertBody: string | null = null;
  private localizedAlertKey: string | null = null;
  private localizedAlertArguments: string[] | null = null;
  private alertTitle: string | null = null;
  private localizedAlertTitleKey: string | null = null;
  private localizedAlertTitleArguments: string[] | null = null;
  private alertSubtitle: string | null = null;
  private localizedAlertSubtitleKey: string | null = null;
  private localizedAlertSubtitleArguments: string[] | null = null;
  private launchImageFileName: string | null = null;
  private showActionButton = true;
  private actionButtonLabel: string | null = null;
  private localizedActionButtonKey: string | null = null;
  private badgeNumber: number | null = null;
  private soundFileName: string | null = null;
  private soundForCriticalAlert: { critical: 0 | 1; name: string; volume: number } | null = null;
  private categoryName: string | null = null;
  private contentAvailable = false;
  private mutableContent = false;
  private threadId: string | null = null;
  private targetContentId: string | null = null;
  private summaryArgument: string | null = null;
  private summaryArgumentCount: number | null = null;
  private interruptionLevel: InterruptionLevel | null = null;
  private relevanceScore: number | null = null;
  private urlArguments: string[] | null = null;
  private readonly customProperties = new Map<string, unknown>();
  private preferStringRepresentationForAlerts = false;
  private event: LiveActivityEvent | null = null;
  private timestamp: Date | null = null;
  private dismissalDate: Date | null = null;
  private staleDate: Date | null = null;
  private attributesType: string | null = null;
  private attributes: JsonObject | null = null;
  private contentState: JsonObject | null = null;

  /**
   * When `true`, an alert with nothing but a body is written as a plain string (`"alert": "body"`) rather than a
   * dictionary. Off by default.
   */
  setPreferStringRepresentationForAlerts(prefer: boolean): this {
    this.preferStringRepresentationForAlerts = prefer;
    return this;
  }

  /** Sets the literal text of the alert message. */
  setAlertBody(alertBody: string | null): this {
    this.alertBody = alertBody;
    return this;
  }

  /** Sets the key of a localized alert message in the app's bundle, plus format arguments. */
  setLocalizedAlertMessage(localizedAlertKey: string | null, ...alertArguments: string[]): this {
    this.localizedAlertKey = localizedAlertKey;
    this.localizedAlertArguments = alertArguments.length > 0 ? alertArguments : null;
    return this;
  }

  setAlertTitle(alertTitle: string | null): this {
    this.alertTitle = alertTitle;
    return this;
  }

  setLocalizedAlertTitle(localizedAlertTitleKey: string | null, ...alertTitleArguments: string[]): this {
    this.localizedAlertTitleKey = localizedAlertTitleKey;
    this.localizedAlertTitleArguments = alertTitleArguments.length > 0 ? alertTitleArguments : null;
    return this;
  }

  setAlertSubtitle(alertSubtitle: string | null): this {
    this.alertSubtitle = alertSubtitle;
    return this;
  }

  setLocalizedAlertSubtitle(localizedAlertSubtitleKey: string | null, ...alertSubtitleArguments: string[]): this {
    this.localizedAlertSubtitleKey = localizedAlertSubtitleKey;
    this.localizedAlertSubtitleArguments = alertSubtitleArguments.length > 0 ? alertSubtitleArguments : null;
    return this;
  }

  setLaunchImageFileName(launchImageFileName: string | null): this {
    this.launchImageFileName = launchImageFileName;
    return this;
  }

  /** Whether the alert should show an action button. `true` by default. */
  setShowActionButton(showActionButton: boolean): this {
    this.showActionButton = showActionButton;
    return this;
  }

  /** Sets the literal label of the action button. Clears any localized action button key. */
  setActionButtonLabel(action: string | null): this {
    this.actionButtonLabel = action;
    this.localizedActionButtonKey = null;
    return this;
  }

  /** Sets the localized key of the action button label. Clears any literal action button label. */
  setLocalizedActionButtonKey(localizedActionButtonKey: string | null): this {
    this.localizedActionButtonKey = localizedActionButtonKey;
    this.actionButtonLabel = null;
    return this;
  }

  /** Sets the number on the app icon's badge. `0` removes the badge; `null` leaves it unchanged. */
  setBadgeNumber(badgeNumber: number | null): this {
    this.badgeNumber = badgeNumber;
    return this;
  }

  setCategoryName(categoryName: string | null): this {
    this.categoryName = categoryName;
    return this;
  }

  /** Sets the sound to play, by file name in the app bundle; use {@link DEFAULT_SOUND_FILENAME} for the system sound. */
  setSound(soundFileName: string | null): this;
  /** Sets the sound for a critical alert, at a volume between 0 and 1 inclusive. */
  setSound(soundFileName: string, isCriticalAlert: boolean, soundVolume: number): this;
  setSound(soundFileName: string | null, isCriticalAlert?: boolean, soundVolume?: number): this {
    if (isCriticalAlert === undefined || soundVolume === undefined) {
      this.soundFileName = soundFileName;
      this.soundForCriticalAlert = null;
      return this;
    }

    if (soundFileName == null) {
      throw new TypeError("Sound file name must not be null.");
    }
    if (!(soundVolume >= 0 && soundVolume <= 1)) {
      throw new RangeError("Sound volume must be between 0.0 and 1.0 (inclusive).");
    }

    this.soundFileName = null;
    this.soundForCriticalAlert = { critical: isCriticalAlert ? 1 : 0, name: soundFileName, volume: soundVolume };
    return this;
  }

  /** Marks the notification as a background update (`content-available: 1`). */
  setContentAvailable(contentAvailable: boolean): this {
    this.contentAvailable = contentAvailable;
    return this;
  }

  /** Lets a notification service extension modify the notification (`mutable-content: 1`). */
  setMutableContent(mutableContent: boolean): this {
    this.mutableContent = mutableContent;
    return this;
  }

  setThreadId(threadId: string | null): this {
    this.threadId = threadId;
    return this;
  }

  setTargetContentId(targetContentId: string | null): this {
    this.targetContentId = targetContentId;
    return this;
  }

  setSummaryArgument(summaryArgument: string | null): this {
    this.summaryArgument = summaryArgument;
    return this;
  }

  setSummaryArgumentCount(summaryArgumentCount: number | null): this {
    if (summaryArgumentCount != null && summaryArgumentCount < 1) {
      throw new RangeError("Summary argument count must be positive.");
    }
    this.summaryArgumentCount = summaryArgumentCount;
    return this;
  }

  setInterruptionLevel(interruptionLevel: InterruptionLevel | null): this {
    this.interruptionLevel = interruptionLevel;
    return this;
  }

  /** Sets how the system ranks the notification in the notification summary, from 0 to 1. */
  setRelevanceScore(relevanceScore: number | null): this {
    if (relevanceScore != null && Number.isNaN(relevanceScore)) {
      throw new RangeError(`Relevance score must be a number, but was actually ${relevanceScore}`);
    }
    this.relevanceScore = relevanceScore;
    return this;
  }

  /** Sets the arguments for a Safari push notification's URL format string. */
  setUrlArguments(...urlArguments: string[]): this;
  setUrlArguments(urlArguments: string[] | null): this;
  setUrlArguments(...args: Array<string | string[] | null>): this {
    const [first] = args;
    this.urlArguments = Array.isArray(first) ? [...first] : first === null ? null : (args as string[]);
    return this;
  }

  /**
   * Adds a custom, top-level property to the payload. Values are serialized with `JSON.stringify`.
   *
   * @throws TypeError if `key` is `aps`, which is reserved
   */
  addCustomProperty(key: string, value: unknown): this {
    if (key === APS_KEY) {
      throw new TypeError("Custom property key must not be aps");
    }
    this.customProperties.set(key, value);
    return this;
  }

  /** Sets the type of the Live Activity attributes for push-to-start Live Activities. */
  setAttributesType(attributesType: string | null): this {
    this.attributesType = attributesType;
    return this;
  }

  /** Sets the attributes of a push-to-start Live Activity. */
  setAttributes(attributes: JsonObject | null): this {
    this.attributes = attributes;
    return this;
  }

  /** Sets the content state of a Live Activity. */
  setContentState(contentState: JsonObject | null): this {
    this.contentState = contentState;
    return this;
  }

  /** Sets the Live Activity event. Setting one makes this a Live Activity payload. */
  setEvent(event: LiveActivityEvent | null): this {
    this.event = event;
    return this;
  }

  /** Sets the time at which a Live Activity update was generated. */
  setTimestamp(timestamp: Date | null): this {
    this.timestamp = timestamp;
    return this;
  }

  /** Sets the time at which an ended Live Activity is removed from the Lock Screen. */
  setDismissalDate(dismissalDate: Date | null): this {
    this.dismissalDate = dismissalDate;
    return this;
  }

  /** Sets the time at which a Live Activity becomes stale. */
  setStaleDate(staleDate: Date | null): this {
    this.staleDate = staleDate;
    return this;
  }

  /** Builds the payload as a JSON string, or with a custom serializer. */
  build(serialize: (payload: JsonObject) => string = JSON.stringify): string {
    return serialize(this.buildPayloadObject());
  }

  /** Builds an MDM payload with the given push magic value; all other properties are ignored. */
  buildMdmPayload(pushMagicValue: string, serialize: (payload: { mdm: string }) => string = JSON.stringify): string {
    return serialize({ mdm: pushMagicValue });
  }

  private buildPayloadObject(): JsonObject {
    const isLiveActivityPayload = this.event !== null;
    const aps: JsonObject = {};

    if (this.badgeNumber !== null) aps["badge"] = this.badgeNumber;

    if (this.soundFileName !== null && !isLiveActivityPayload) {
      aps["sound"] = this.soundFileName;
    } else if (this.soundForCriticalAlert !== null) {
      aps["sound"] = { ...this.soundForCriticalAlert };
    }

    if (this.categoryName !== null) aps["category"] = this.categoryName;
    if (this.contentAvailable) aps["content-available"] = 1;
    if (this.mutableContent) aps["mutable-content"] = 1;
    if (this.threadId !== null) aps["thread-id"] = this.threadId;
    if (this.targetContentId !== null) aps["target-content-id"] = this.targetContentId;
    if (this.urlArguments !== null) aps["url-args"] = [...this.urlArguments];
    if (this.interruptionLevel !== null) aps["interruption-level"] = this.interruptionLevel;
    if (this.relevanceScore !== null) aps["relevance-score"] = this.relevanceScore;
    if (this.timestamp !== null) aps["timestamp"] = epochSeconds(this.timestamp);
    if (this.event !== null) aps["event"] = this.event;
    if (this.attributesType !== null) aps["attributes-type"] = this.attributesType;
    if (this.attributes !== null) aps["attributes"] = this.attributes;
    if (this.contentState !== null) aps["content-state"] = this.contentState;
    if (this.dismissalDate !== null) aps["dismissal-date"] = epochSeconds(this.dismissalDate);
    if (this.staleDate !== null) aps["stale-date"] = epochSeconds(this.staleDate);

    const alert: JsonObject = {};

    if (this.alertBody !== null) alert["body"] = this.alertBody;
    if (this.alertTitle !== null) alert["title"] = this.alertTitle;
    if (this.alertSubtitle !== null) alert["subtitle"] = this.alertSubtitle;
    if (this.summaryArgument !== null) alert["summary-arg"] = this.summaryArgument;
    if (this.summaryArgumentCount !== null) alert["summary-arg-count"] = this.summaryArgumentCount;

    if (this.showActionButton) {
      if (this.localizedActionButtonKey !== null) alert["action-loc-key"] = this.localizedActionButtonKey;
      if (this.actionButtonLabel !== null) alert["action"] = this.actionButtonLabel;
    } else {
      alert["action-loc-key"] = null;
    }

    if (this.localizedAlertKey !== null) {
      alert["loc-key"] = this.localizedAlertKey;
      if (this.localizedAlertArguments !== null) alert["loc-args"] = [...this.localizedAlertArguments];
    }
    if (this.localizedAlertTitleKey !== null) {
      alert["title-loc-key"] = this.localizedAlertTitleKey;
      if (this.localizedAlertTitleArguments !== null) alert["title-loc-args"] = [...this.localizedAlertTitleArguments];
    }
    if (this.localizedAlertSubtitleKey !== null) {
      alert["subtitle-loc-key"] = this.localizedAlertSubtitleKey;
      if (this.localizedAlertSubtitleArguments !== null) {
        alert["subtitle-loc-args"] = [...this.localizedAlertSubtitleArguments];
      }
    }

    if (this.launchImageFileName !== null) alert["launch-image"] = this.launchImageFileName;
    if (this.soundFileName !== null && isLiveActivityPayload) alert["sound"] = this.soundFileName;

    const alertKeys = Object.keys(alert);
    if (alertKeys.length === 1 && alertKeys[0] === "body" && this.preferStringRepresentationForAlerts) {
      aps["alert"] = alert["body"];
    } else if (alertKeys.length > 0) {
      aps["alert"] = alert;
    }

    const payload: JsonObject = { aps };
    for (const [key, value] of this.customProperties) {
      payload[key] = value;
    }
    return payload;
  }
}
