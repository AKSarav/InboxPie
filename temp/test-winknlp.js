// Load wink-nlp package.
const winkNLP = require( 'wink-nlp' );
// Load english language model.
const model = require( 'wink-eng-lite-web-model' );
// Instantiate winkNLP.
const nlp = winkNLP( model );
// Obtain "its" helper to extract item properties.
const its = nlp.its;
// Obtain "as" reducer helper to reduce a collection.
const as = nlp.as;
 
// NLP Code.
const text = `
subject: Life Insurance Corporation of India: Communication in respect of\n Tax Deduction at Source (TDS) on Dividend\nfrom: Life Insurance Corporation of India <cs.lic@kfintech.com> │ │ \ndomain: kfintech.com\n\nLIFE INSURANCE CORPORATION OF INDIA (constituted under the Life Insurance Corporation Act, 1956) IRDAI Registration No. 512 Central Office: 'Yogakshema', Je │ │ evan Bima Marg, Mumbai, Maharashtra - 400 021 Tel. No.: 022 - 2202 2079 Email: investors@licindia.com; website: www.licindia.in Date: July 07, 2023 Ref: Folio / DP Id & Client Id No: │ │ 1601430105207424 Name of the Shareholder: SARAVANAN T Dear Member, We are pleased to inform you that the Board of Directors of Life Insurance Corporation of India ("LIC" or "LICI" o │ │ r "the Corporation") in its meeting held on May 24, 2023, has recommended a final dividend of ₹ 3.00 (Three Rupees) per equity share of the face value of ₹ 10/- each (30%), for the F │ │ inancial Year 2022-23, subject to the approval of members of the Corporation at the ensuing Annual General Meeting ("AGM") scheduled to be held on Tuesday, August 22, 2023. The recor │ │ d date for the purpose of final dividend would be Friday, July 21, 2023. The dividend would be paid to the eligible members within a period of 30 days from the date of AGM, i.e., on │ │ or before September 20, 2023, electronically, through various online modes or any other permissible modes to those members who have updated their bank account details with their Depo │ │ sitory Participants ("DPs"). As per the Income tax Act, 1961, as amended, dividend declared and paid by an entity is taxable in the hands of its members w.e.f. April 1, 2020, and acc │ │ ordingly Corporation is required to deduct tax at source ("TDS") from dividend paid to the members at the applicable rates. Table 1: TDS to be deducted at higher rate in case of non- │ │ filers of Return of Income (Section 206AB): ParticularApplicable TDS rateSection 206AB of the Income Tax Act, 1961 ("IT Act"), effective from July 1, 2021, higher of rates of tax wou │ │ ld be deducted in case of payments to 'Specified Persons'At twice the rate specified in the relevant provision of the Act; Or At the rate of 5% 'Specified Person' means a person who │ │ has: not filed the income tax return for the previous year immediately prior to the financial year in which tax is required to be deducted, for which the time limit for filing the re │ │ turn of income under Section 139(1) of the Act has expired; and the aggregate of tax deducted at source ('TDS') and tax collected at source ('TCS') is INR 50,000 or more in that prev │ │ ious year. A Non-resident who does not have the permanent establishment in India is excluded from the scope of a Specified person. For specified persons who have not submitted their │ │ Permanent Account Number ('PAN') as well as not filed their return of income tax shall be deducted at the higher of the two rates prescribed under Sections 206AA and 206AB of the Act │ │ . Further as per Section 139AA of the IT Act, every person who has been allotted a PAN and who is eligible to obtain Aadhaar, shall be required to link the PAN with Aadhaar. In case │ │ of failure to comply with this, the PAN allotted shall be deemed to be invalid/inoperative and he shall be liable to all consequences under the Act and tax shall be deducted at highe │ │ r rates as prescribed under the Act. The Tables below summarize the applicable TDS provisions in accordance with the provisions of the IT Act, for various member categories, includin │ │ g Resident/Non-Resident members. Table 2: Resident Members: For Financial Year 2023-24 taxes shall be deducted at source under Section 194 of the IT Act as follows:- SectionCategory │ │ of MembersApplicable Tax rateExemption applicability/ Documentation requirements194Members having valid PAN10% or as notified by the Government of IndiaUpdate valid PAN if not alread │ │ y done with respective depositories206AA and 206ABMembers not having PAN / invalid PAN; and Members who have not filed their Income-tax returns in the last financial year (Specified │ │ Person as per Section 206AB of the Income-tax Act)20%Update valid PAN if not already done with respective depositories However, no tax shall be deducted on the dividend payable to a │ │ Resident Member (Indiv
`
const doc = nlp.readDoc( text );
 
// console.log( doc.out() );
// // -> Hello   World🌎! How are you?
 
// console.log( doc.sentences().out() );
// // -> [ 'Hello   World🌎!', 'How are you?' ]
 
console.log( doc.entities().out( its.detail ) );
// -> [ { value: '🌎', type: 'EMOJI' } ]
 
// console.log( doc.tokens().out() );
// // -> [ 'Hello', 'World', '🌎', '!', 'How', 'are', 'you', '?' ]
 
// console.log( doc.tokens().out( its.type, as.freqTable ) );
// // -> [ [ 'word', 5 ], [ 'punctuation', 2 ], [ 'emoji', 1 ] ]