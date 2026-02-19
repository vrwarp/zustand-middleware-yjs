
import { ChangeType } from "./types";
import { getChanges } from "./diff";

describe("Windowed Lookahead Reproduction", () => {
    it("Detects batch deletion of 5 items as 5 DELETE operations", () => {
        // Log Console Scenario:
        // A: [Log1, ... Log100]
        // B: [Log6, ... Log100] (Batch delete 5)

        const generateLogs = (start: number, count: number) =>
            Array.from({ length: count }, (_, i) => `Log${start + i}`);

        const a = generateLogs(1, 100);
        const b = generateLogs(6, 95); // Log6 to Log100

        const changes = getChanges(a, b);

        // We expect exactly 5 deletes.
        // Current algorithm will likely produce 95 updates + deletes/inserts

        const deleteCount = changes.filter(c => c[0] === ChangeType.DELETE).length;
        const updateCount = changes.filter(c => c[0] === ChangeType.UPDATE).length;
        const insertCount = changes.filter(c => c[0] === ChangeType.INSERT).length;

        console.log(`Changes: ${changes.length} (Deletes: ${deleteCount}, Updates: ${updateCount}, Inserts: ${insertCount})`);

        expect(updateCount).toBe(0);
        expect(insertCount).toBe(0);
        expect(deleteCount).toBe(5);
        expect(changes).toHaveLength(5);

        // Precise check: For sequential patching, we expect "Delete at 0" repeatedly.
        // Or "Delete at index" where index is constant for the block.
        changes.forEach((change) => {
            expect(change[0]).toBe(ChangeType.DELETE);
            expect(change[1]).toBe(0); // All deletes should target the head (current index)
        });
    });

    it("Detects batch insertion of 5 items as 5 INSERT operations", () => {
        // Reverse Scenario:
        // A: [Log6, ... Log100]
        // B: [Log1, ... Log100] (Batch insert 5 at start)

        const generateLogs = (start: number, count: number) =>
            Array.from({ length: count }, (_, i) => `Log${start + i}`);

        const a = generateLogs(6, 95);
        const b = generateLogs(1, 100);

        const changes = getChanges(a, b);

        const deleteCount = changes.filter(c => c[0] === ChangeType.DELETE).length;
        const updateCount = changes.filter(c => c[0] === ChangeType.UPDATE).length;
        const insertCount = changes.filter(c => c[0] === ChangeType.INSERT).length;

        console.log(`Changes: ${changes.length} (Deletes: ${deleteCount}, Updates: ${updateCount}, Inserts: ${insertCount})`);

        expect(updateCount).toBe(0);
        expect(deleteCount).toBe(0);
        expect(insertCount).toBe(5);
        expect(changes).toHaveLength(5);

        // precise check
        for (let i = 0; i < 5; i++) {
            expect(changes[i][0]).toBe(ChangeType.INSERT);
            expect(changes[i][1]).toBe(i);
            expect(changes[i][2]).toBe(`Log${i + 1}`);
        }
    });
});
