import { DEFAULT_DISCLOSURE } from "@klon/core";
import { createClone } from "@/lib/actions";

export default function NewClonePage() {
  return (
    <form action={createClone} className="card stack">
      <h1>Klon anlegen</h1>
      <label>
        Name
        <input name="name" required />
      </label>
      <label>
        ElevenLabs-Stimme
        <input name="voiceId" placeholder="Voice-Id" />
      </label>
      <label>
        HeyGen-Avatar
        <input name="heygenAvatarId" />
      </label>
      <label>
        HeyGen-Stimme
        <input name="heygenVoiceId" />
      </label>
      <label>
        Wissen
        <textarea name="knowledge" />
      </label>
      <label>
        Hinweis zu Beginn jedes Calls
        <textarea name="disclosureText" defaultValue={DEFAULT_DISCLOSURE} />
      </label>
      <label>
        Calendly-Event-Typ-URI
        <input name="calendlyEventTypeUri" placeholder="optional, sonst der einzige Klon" />
      </label>
      <label>
        Versand
        <select name="preferredMail" defaultValue="auto">
          <option value="auto">Gmail, sonst Outlook</option>
          <option value="gmail">Nur Gmail</option>
          <option value="outlook">Nur Outlook</option>
        </select>
      </label>
      <label className="row">
        <input type="checkbox" name="autoSendOffers" />
        Automatisch senden, wenn jede Position in der Preisliste steht
      </label>
      <button type="submit">Speichern</button>
    </form>
  );
}
