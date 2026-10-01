import {z} from 'zod';
import {appResource, mcpServer, tool} from '@agentback/mcp';
import {widgetDomain} from '../widget/claude-domain.js';
import {widgetHtml} from '../widget/html.js';

const UI_URI = 'ui://widgets/greeting';

const GreetingIn = z.object({name: z.string().min(1).max(64)});
const GreetingOut = z.object({greeting: z.string()});

const domain = widgetDomain();

/**
 * An MCP Apps (SEP-1865) tool: a host that supports MCP Apps (Claude, ChatGPT,
 * VS Code, Goose) renders the `ui://` widget below for this tool's result,
 * binding the result's `structuredContent` — so declare an `output:` schema.
 */
@mcpServer()
export class GreetingWidgetTools {
  @tool('show_greeting', {
    description: 'Greet someone and show the greeting as an interactive card.',
    input: GreetingIn,
    output: GreetingOut,
    ui: {resourceUri: UI_URI},
    // A presentation hint, not authorization: the tool only reads.
    annotations: {readOnlyHint: true, openWorldHint: false},
  })
  async showGreeting(
    input: z.infer<typeof GreetingIn>,
  ): Promise<z.infer<typeof GreetingOut>> {
    return {greeting: `Hello, ${input.name}!`};
  }

  // The widget, served with the mcp-app MIME type. `@appResource` puts its
  // `_meta.ui` (here Claude's `domain`, when PUBLIC_URL is set) on the content
  // item `resources/read` returns. The view is inlined, so no `csp` is needed.
  @appResource(UI_URI, {
    name: 'greeting-widget',
    title: 'Greeting',
    prefersBorder: true,
    ...(domain ? {domain} : {}),
  })
  greetingWidget(): Promise<string> {
    return widgetHtml();
  }
}
