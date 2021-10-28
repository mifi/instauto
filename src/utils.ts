import { ElementHandle, Page } from "puppeteer";

export class Utils {
	static puppeteerPageOverride(page: Page): Page {
    	const originalXPath = page.$x;
    	page.$x = async function (expression: string): Promise<ElementHandle[]> {
    		const containsSensitiveRegexp = new RegExp(/\[contains\(text\(\), (.*)\)\]/);
    		const alphabetLo = 'abcdefghijklmnopqrstuvwxyz';
    		const alphabetUp = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    		expression = expression.replace(containsSensitiveRegexp, (match: string, p1: string): string => {
    			return `[contains(translate(text(), '${alphabetUp}', '${alphabetLo}'), ${p1.toLowerCase()})]`
			});
    		return originalXPath.apply(this, [expression]);
    	}
    	return page;
	}
}