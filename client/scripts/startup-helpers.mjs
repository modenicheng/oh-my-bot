/** Enter through the production splash; never bypass its audio/user-gesture gate. */
export async function startClient(page) {
  await page.locator('#startup[data-state="ready"]').waitFor({ timeout: 30000 })
  await page.locator('#startup').focus()
  await page.keyboard.press('Enter')
  await page.locator('#startup').waitFor({ state: 'hidden' })
}
