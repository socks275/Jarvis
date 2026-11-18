export const EXAMPLES = [
  {
    label: 'Write better copy',
    prompt: 'Rewrite this onboarding message to make it warmer and clearer: “You must configure your workspace before proceeding.”',
    draft: 'Let’s set up your workspace. Once it’s ready, you can start your first project.\n\nButton: Set up workspace',
    review: 'The tone is friendlier and the button tells people what to do. The second sentence promises a first project, which may not be the actual next step. Keep the outcome general and make the message a little shorter.',
    final: 'Let’s set up your workspace so you’re ready to get started.\n\nButton: Set up workspace',
    peer: 'First, make this workspace yours. Set it up to continue.\n\nButton: Set up my workspace',
  },
  {
    label: 'Plan a launch',
    prompt: 'Make a practical one-week launch plan for a small indie newsletter. Assume one person and no marketing budget.',
    draft: 'Monday: Pick one audience and write a one-sentence promise.\nTuesday: Make a simple signup page.\nWednesday: Draft the first issue.\nThursday: Share the draft with a few readers.\nFriday: Send the issue and share one useful excerpt.\nWeekend: Review signups and plan issue two.',
    review: 'This fits a solo schedule. Add a test send before launch to catch broken signup links and missing unsubscribe details. Use replies and confirmed signups as the main signals rather than open rates.',
    final: 'Mon — Name one reader and write a clear promise.\nTue — Publish a signup page with a sample paragraph.\nWed — Draft issue one and invite three people in your audience to review it.\nThu — Revise, test signup and unsubscribe, and send yourself a preview.\nFri — Send the issue. Share one useful excerpt wherever your readers already gather, if the community allows it.\nWeekend — Count confirmed signups, read replies, and choose one improvement for issue two.',
    peer: 'Work backwards from Friday’s send: draft one useful issue first, test that people can subscribe and unsubscribe, then invite a handful of interested readers personally. Start with their replies before adding more promotion channels.',
  },
  {
    label: 'Explain a concept',
    prompt: 'Explain the difference between a browser cache and a cookie to someone who has never worked on a website.',
    draft: 'A cache is your browser’s shortcut: it saves copies of files so pages load faster. A cookie is a small note that a site asks the browser to keep, such as a reminder that you’ve signed in.',
    review: 'Good distinction. Make clear that a cookie usually holds a short identifier, not the whole account. A quick example of what happens when you clear each will make the idea stick.',
    final: 'A cache keeps copies of things a site has already sent you, like its logo, so your browser doesn’t have to fetch them again. A cookie keeps a small piece of information a site uses to remember something, such as a code for your signed-in session.\n\nClear the cache and a page may load more slowly the next time. Clear the cookies and you may have to sign in again.',
    peer: 'Think of the cache as a folder of spare copies, and a cookie as a claim ticket. The cache saves a trip to get the same file; the cookie helps the site recognise a session or remember a setting.',
  },
];

export function demoGenerator(prompt, delay = 520) {
  const sample = EXAMPLES.find((example) => example.prompt === prompt);
  return async ({ stage, signal }) => {
    signal.throwIfAborted();
    if (delay) {
      await new Promise((resolve, reject) => {
        const stop = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, delay);
        signal.addEventListener('abort', stop, { once: true });
      });
    }
    if (sample) return sample[stage.key];
    return {
      draft: `Demo first pass\n\nYou entered: ${prompt}\n\nIn a local AI run, the driver would draft a response to this prompt. This demo does not generate an answer.`,
      review: 'Demo review\n\nIn a local AI run, the reviewer would receive the original request and the draft, then flag gaps or suggest changes.',
      final: 'Demo final pass\n\nThe relay is complete. For a response to your own prompt, choose Models and load a free local GGUF model. For an example with sample answers, select one of the example prompts.',
      peer: 'Demo independent pass\n\nIn a local AI run, a reviewer would answer the same prompt without seeing the driver’s response.',
    }[stage.key];
  };
}
