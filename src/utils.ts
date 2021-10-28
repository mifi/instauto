import { ElementHandle, Page } from "puppeteer";

export class Utils {
	static puppeteerPageOverride(page: Page): Page {
    	const originalXPath = page.$x;
    	page.$x = async function (expression: string): Promise<ElementHandle[]> {
    		const containsSensitiveRegexp = new RegExp(/\[contains\(text\(\), (.*)\)\]/);
    		const alphabetLo = 'abcdefghijklmnopqrstuvwxyz';
    		const alphabetUp = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    		expression.replace(containsSensitiveRegexp, `[contains(translate(text(), '${alphabetLo}', '${alphabetUp}'), $1)]`);
    		return originalXPath.apply(this, expression);
    	}
    	return page;
	}
}