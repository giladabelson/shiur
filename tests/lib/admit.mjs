// Waiting room helpers: a student only enters the lesson once a teacher device lets them in.

/** On a teacher (or iPad) page: wait for `name` in the waiting-room notice and click "הכנס". */
export async function admit(staffPage, name, { timeout = 20000 } = {}) {
  const item = staffPage.locator(`.lobby-item[data-name="${name}"]`).first();
  await item.waitFor({ timeout });
  await item.locator("button.admit").click();
}

/** On a student page: wait until it is past the waiting room and in the lesson. */
export async function inLesson(page, { timeout = 20000 } = {}) {
  await page.waitForSelector(".lesson", { timeout });
  await page.waitForFunction(() => window.__room?.lobby?.kind === "admitted", null, { timeout });
}

/** Student joined (clicked "הצטרף"): the teacher lets them in, then wait until they are in. */
export async function admitInto(staffPage, studentPage, name) {
  await admit(staffPage, name);
  await inLesson(studentPage);
}
