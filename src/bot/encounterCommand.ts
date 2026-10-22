import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder, type RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import { EncounterError } from '../encounter/rules.js';
import { encounterFromWiki, WikiEncountersError } from '../encounter/wiki.js';
import type { EncounterOutcome, EncounterState, WikiEncounter, WikiEncounterSummary } from '../shared/types.js';

/** /encounter start|link|end (#49). For the DM by default (Manage Server), like /record. */
export const ENCOUNTER_COMMAND: RESTPostAPIChatInputApplicationCommandsJSONBody = new SlashCommandBuilder()
  .setName('encounter')
  .setDescription('Run a fight: players join from a link on their phone')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) =>
    s
      .setName('start')
      .setDescription('Start an encounter and post the join link here')
      .addStringOption((o) => o.setName('name').setDescription('One prepared in the wiki, or a name for a blank one').setAutocomplete(true).setMaxLength(80)),
  )
  .addSubcommand((s) => s.setName('link').setDescription('Post the join link again'))
  .addSubcommand((s) => s.setName('end').setDescription('End the encounter; the link stops working'))
  .toJSON();

/** A public post in the channel: the encounter and a Join button (a link button). */
export interface EncounterPost {
  title: string;
  description: string;
  /** The Join button's link; absent for a post with no button (the end). */
  url?: string;
}

export interface EncounterCommandDeps {
  store: { current(): EncounterState | null; start(s: EncounterState | { title: string }): EncounterState; end(): EncounterOutcome; newId(): string };
  wiki: { list(): Promise<WikiEncounterSummary[]>; get(id: string, campaign?: string): Promise<WikiEncounter> };
  /** The public join link for the running encounter, or null when no public address is set. */
  joinUrl(): string | null;
  now?: () => number;
}

/** What /encounter answers: a reply only the DM sees, and maybe a post for everyone. */
export interface EncounterReply {
  reply: string;
  post?: EncounterPost;
}

/** The value an autocomplete choice carries: a wiki encounter. Anything else is a blank one's name. */
const WIKI_PREFIX = 'wiki:';
const choiceValue = (e: WikiEncounterSummary) => `${WIKI_PREFIX}${e.campaign}\n${e.id}`.slice(0, 100);

/** The autocomplete list for /encounter start: prepared encounters not yet run, matching what's typed. */
export function encounterChoices(typed: string, list: WikiEncounterSummary[]): Array<{ name: string; value: string }> {
  const q = typed.trim().toLowerCase();
  const campaigns = new Set(list.map((e) => e.campaign));
  return list
    .filter((e) => !e.run && (!q || e.title.toLowerCase().includes(q) || (e.place ?? '').toLowerCase().includes(q)))
    .slice(0, 25)
    .map((e) => ({ name: `${e.title}${e.place ? ` · ${e.place}` : ''}${campaigns.size > 1 ? ` (${e.campaign})` : ''}`.slice(0, 100), value: choiceValue(e) }));
}

export function joinPost(state: EncounterState, url: string, place?: string | null): EncounterPost {
  return {
    title: `⚔️ ${state.title}`,
    description: `${place ? `${place}. ` : ''}Tap **Join** to follow the fight and take your turns: on your phone or in a browser, nothing to install.`,
    url,
  };
}

const NO_PUBLIC =
  'Players can’t reach it yet: turn on Tailscale Funnel and add its address in the app (Settings → Players). The DM tracker works meanwhile.';

export async function runEncounterCommand(sub: 'start' | 'link' | 'end', name: string | undefined, deps: EncounterCommandDeps): Promise<EncounterReply> {
  const current = deps.store.current();
  try {
    switch (sub) {
      case 'start': {
        if (current) return { reply: `**${current.title}** is still running. Use \`/encounter end\` first, or \`/encounter link\` to post its link.` };
        let state: EncounterState;
        let place: string | null = null;
        if (name?.startsWith(WIKI_PREFIX)) {
          const [campaign, id] = name.slice(WIKI_PREFIX.length).split('\n');
          const prepared = await deps.wiki.get(id!, campaign);
          place = prepared.place;
          state = deps.store.start(encounterFromWiki(prepared, deps.store.newId(), (deps.now ?? Date.now)()));
        } else {
          state = deps.store.start({ title: name?.trim() || 'Encounter' });
        }
        const url = deps.joinUrl();
        const reply = `Started **${state.title}**. Set initiative in the app (Encounters).`;
        return url ? { reply, post: joinPost(state, url, place) } : { reply: `${reply}\n${NO_PUBLIC}` };
      }
      case 'link': {
        if (!current) return { reply: 'No encounter is running. Start one with `/encounter start`.' };
        const url = deps.joinUrl();
        return url ? { reply: 'Posted.', post: joinPost(current, url) } : { reply: NO_PUBLIC };
      }
      case 'end': {
        if (!current) return { reply: 'No encounter is running.' };
        const outcome = deps.store.end();
        // Players hear only that it's over: the DM's summary can name foes they never saw.
        return {
          reply: `Ended. ${outcome.text}`,
          post: { title: `${current.title} is over`, description: `After ${outcome.rounds} round${outcome.rounds === 1 ? '' : 's'}. The join link no longer works.` },
        };
      }
    }
  } catch (err) {
    if (err instanceof EncounterError || err instanceof WikiEncountersError) return { reply: `Couldn't: ${err.message}` };
    throw err;
  }
}
