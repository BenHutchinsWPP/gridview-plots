// src/ui/confirm-allocation.ts
//
// The second click before a very large allocation, shared by every picker
// with a "Keep everything" so they cannot drift apart. **The wording never
// predicts success or failure**: whether a multi-hundred-MB `Float32Array` is
// served depends on the browser, device and tab, so it states the arithmetic
// and hands the choice over.

/** A judgement line, not a measured limit: above the ordinary 170-207 MB
 * full-width wide case, below the 1.65 GB long bus export. Lower trains the
 * user to click through. */
const LARGE_ALLOCATION_BYTES = 512 * 1024 * 1024;

/** What the dialog says: the readout line, the body, the button that goes
 * ahead. */
interface Wording {
  readonly readout: string;
  readonly body: string;
  readonly go: string;
}

/** `true` to go ahead. Under the threshold it resolves immediately, so the
 * guard is this function, not an `if` at each call site. `what` completes
 * "Keeping ...". */
export function confirmLargeAllocation(bytes: number, what: string): Promise<boolean> {
  return confirmLarge(bytes, {
    readout: `Keeping ${what} asks for ${megabytes(bytes)} MB.`,
    body:
      'Whether a block that size can be allocated depends on your browser, your machine and ' +
      'what this tab is already holding, so this might load fine or the tab might run out of ' +
      'memory trying. If you do not need every series, going back and filtering to the ones ' +
      'you plot is the cheaper answer.',
    go: 'Load it anyway',
  });
}

/** The same second click before writing a large file. `bytes` is an upper
 * bound on what writing holds at its peak; `what` completes "Writing ...". */
export function confirmLargeDownload(bytes: number, what: string): Promise<boolean> {
  return confirmLarge(bytes, {
    readout: `Writing ${what} needs up to ${megabytes(bytes)} MB while the file is built.`,
    body:
      'Whether that much can be held depends on your browser, your machine and what this tab ' +
      'is already holding, so the file might be written fine or the tab might run out of ' +
      'memory trying. Filtering the tab to fewer rows is the cheaper answer.',
    go: 'Write it anyway',
  });
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}

function confirmLarge(bytes: number, wording: Wording): Promise<boolean> {
  if (bytes <= LARGE_ALLOCATION_BYTES) return Promise.resolve(true);

  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'modal modal-narrow';
    backdrop.appendChild(modal);

    const title = document.createElement('h2');
    title.textContent = 'That is a lot of memory';
    modal.appendChild(title);

    const readout = document.createElement('p');
    readout.className = 'modal-readout';
    readout.textContent = wording.readout;
    modal.appendChild(readout);

    const body = document.createElement('p');
    body.className = 'modal-subtitle';
    body.textContent = wording.body;
    modal.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const anyway = document.createElement('button');
    anyway.type = 'button';
    anyway.className = 'btn';
    anyway.textContent = wording.go;
    const back = document.createElement('button');
    back.type = 'button';
    // The primary button is the cautious one: this dialog is only ever
    // reached by a click that already said "everything".
    back.className = 'btn btn-primary';
    back.textContent = 'Go back';
    actions.append(anyway, back);
    modal.appendChild(actions);

    function close(result: boolean): void {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    }
    // Capture phase, and it stops propagation: the picker underneath still
    // has its own Escape handler on `document`, and an Escape meant for this
    // dialog must not also close the picker behind it.
    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close(false);
    }
    document.addEventListener('keydown', onKey, true);
    anyway.addEventListener('click', () => close(true));
    back.addEventListener('click', () => close(false));

    document.body.appendChild(backdrop);
    back.focus();
  });
}
