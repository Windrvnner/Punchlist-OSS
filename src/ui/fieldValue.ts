/** Whether the checkbox an event came from is now checked */
export const checkedOf = (e: Event) => (e.currentTarget as HTMLInputElement).checked;

/** The value now chosen in the select an event came from */
export const chosenOf = (e: Event) => (e.currentTarget as HTMLSelectElement).value;
