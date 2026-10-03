#!/usr/bin/env python3
"""storm-detector.py - NOAA SPC storm-report detector (OtterQuote issue #2424).

Pulls the SPC daily filtered hail and wind report CSVs for a date, keeps hail >= 1.00 in or
wind >= 60 mph within --radius-miles of a US city of 100,000+ people, drops blocked states,
marks remaining states searched/unresearched, groups into one alert per (state, nearest metro).

Exit codes: 0 = ran fine (alerts or not); 2 = fetch/parse failure (URL and HTTP status printed
to stderr); never mistake a failed fetch for "no storms".
Standard library only.
"""
import argparse, csv, io, json, math, os, sys, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone

# D-344 blocked list
BLOCKED_STATES = {"FL", "LA", "TX"}

HAIL_MIN_IN = 1.00
WIND_MIN_MPH = 60
DEFAULT_RADIUS_MILES = 40.0
SPC_BASE = "https://www.spc.noaa.gov/climo/reports/"
HERE = os.path.dirname(os.path.abspath(__file__))
_STATUTE_NAME = "storm-detector-statute-states.json"
# Prefer a copy next to the script (repo layout: tools/); fall back to one level up (PC layout).
DEFAULT_STATUTE_FILE = os.path.join(HERE, _STATUTE_NAME)
if not os.path.isfile(DEFAULT_STATUTE_FILE):
    DEFAULT_STATUTE_FILE = os.path.normpath(os.path.join(HERE, "..", _STATUTE_NAME))

# City table: name, state, lat, lon, population.
# Source: US Census Bureau Vintage 2023 Subcounty Population Estimates (sub-est2023.csv, SUMLEV 162
# incorporated places, POPESTIMATE2023 >= 100,000) joined on state+place FIPS to the 2023 Census
# Gazetteer Places file (2023_Gaz_place_national.txt, INTPTLAT/INTPTLONG internal points).
# Retrieved 2026-10-03 from www2.census.gov. Refresh annually. Coordinates are internal points
# of the city boundary, not downtown centres.
CITIES = [
    ('New York', 'NY', 40.6627, -73.9387, 8258035),
    ('Los Angeles', 'CA', 34.0194, -118.4108, 3820914),
    ('Chicago', 'IL', 41.8370, -87.6849, 2664452),
    ('Houston', 'TX', 29.7857, -95.3888, 2314157),
    ('Phoenix', 'AZ', 33.5722, -112.0901, 1650070),
    ('Philadelphia', 'PA', 40.0094, -75.1333, 1550542),
    ('San Antonio', 'TX', 29.4628, -98.5246, 1495295),
    ('San Diego', 'CA', 32.8150, -117.1356, 1388320),
    ('Dallas', 'TX', 32.7933, -96.7665, 1302868),
    ('Jacksonville', 'FL', 30.3369, -81.6616, 985843),
    ('Austin', 'TX', 30.2986, -97.7541, 979882),
    ('Fort Worth', 'TX', 32.7820, -97.3486, 978468),
    ('San Jose', 'CA', 37.2960, -121.8146, 969655),
    ('Columbus', 'OH', 39.9839, -82.9849, 913175),
    ('Charlotte', 'NC', 35.2090, -80.8310, 911311),
    ('Indianapolis', 'IN', 39.7767, -86.1459, 879293),
    ('San Francisco', 'CA', 37.7272, -123.0322, 808988),
    ('Seattle', 'WA', 47.6193, -122.3515, 755078),
    ('Denver', 'CO', 39.7619, -104.8811, 716577),
    ('Oklahoma City', 'OK', 35.4671, -97.5137, 702767),
    ('Nashville-Davidson', 'TN', 36.1718, -86.7850, 687788),
    ('Washington', 'DC', 38.9042, -77.0165, 678972),
    ('El Paso', 'TX', 31.8478, -106.4311, 678958),
    ('Las Vegas', 'NV', 36.2335, -115.2640, 660929),
    ('Boston', 'MA', 42.3386, -71.0183, 653833),
    ('Detroit', 'MI', 42.3830, -83.1022, 633218),
    ('Portland', 'OR', 45.5370, -122.6500, 630498),
    ('Louisville/Jefferson County metro government', 'KY', 38.1654, -85.6474, 622981),
    ('Memphis', 'TN', 35.1090, -89.9675, 618639),
    ('Baltimore', 'MD', 39.3000, -76.6105, 565239),
    ('Milwaukee', 'WI', 43.0633, -87.9667, 561385),
    ('Albuquerque', 'NM', 35.1048, -106.6468, 560274),
    ('Tucson', 'AZ', 32.1530, -110.8708, 547239),
    ('Fresno', 'CA', 36.7827, -119.7934, 545716),
    ('Sacramento', 'CA', 38.5677, -121.4682, 526384),
    ('Mesa', 'AZ', 33.4006, -111.7165, 511648),
    ('Atlanta', 'GA', 33.7629, -84.4227, 510823),
    ('Kansas City', 'MO', 39.1224, -94.5551, 510704),
    ('Colorado Springs', 'CO', 38.8673, -104.7607, 488664),
    ('Omaha', 'NE', 41.2627, -96.0535, 483335),
    ('Raleigh', 'NC', 35.8319, -78.6410, 482295),
    ('Miami', 'FL', 25.7752, -80.2086, 455924),
    ('Virginia Beach', 'VA', 36.7795, -76.0291, 453649),
    ('Long Beach', 'CA', 33.7808, -118.1682, 449468),
    ('Oakland', 'CA', 37.7698, -122.2257, 436504),
    ('Minneapolis', 'MN', 44.9633, -93.2683, 425115),
    ('Bakersfield', 'CA', 35.3532, -119.0379, 413381),
    ('Tulsa', 'OK', 36.1279, -95.9023, 411894),
    ('Tampa', 'FL', 27.9663, -82.4776, 403364),
    ('Arlington', 'TX', 32.7007, -97.1247, 398431),
    ('Wichita', 'KS', 37.6906, -97.3458, 396119),
    ('Aurora', 'CO', 39.7036, -104.7201, 395052),
    ('New Orleans', 'LA', 30.0534, -89.9345, 364136),
    ('Cleveland', 'OH', 41.4785, -81.6794, 362656),
    ('Urban Honolulu', 'HI', 21.3243, -157.8476, 341778),
    ('Anaheim', 'CA', 33.8555, -117.7587, 340512),
    ('Henderson', 'NV', 36.0090, -115.0268, 337305),
    ('Orlando', 'FL', 28.4087, -81.2548, 320742),
    ('Lexington-Fayette', 'KY', 38.0407, -84.4583, 320154),
    ('Stockton', 'CA', 37.9772, -121.3089, 319543),
    ('Riverside', 'CA', 33.9381, -117.3932, 318858),
    ('Corpus Christi', 'TX', 27.7543, -97.1734, 316595),
    ('Irvine', 'CA', 33.6784, -117.7713, 314621),
    ('Cincinnati', 'OH', 39.1402, -84.5058, 311097),
    ('Santa Ana', 'CA', 33.7363, -117.8829, 310539),
    ('Newark', 'NJ', 40.7242, -74.1726, 304960),
    ('St. Paul', 'MN', 44.9489, -93.1041, 303820),
    ('Pittsburgh', 'PA', 40.4399, -79.9757, 303255),
    ('Greensboro', 'NC', 36.0949, -79.8236, 302296),
    ('Durham', 'NC', 35.9781, -78.8995, 296186),
    ('Lincoln', 'NE', 40.8089, -96.6779, 294757),
    ('Jersey City', 'NJ', 40.7114, -74.0648, 291657),
    ('Plano', 'TX', 33.0508, -96.7479, 290190),
    ('Anchorage', 'AK', 61.1743, -149.2843, 286075),
    ('North Las Vegas', 'NV', 36.2899, -115.0892, 284771),
    ('St. Louis', 'MO', 38.6357, -90.2446, 281754),
    ('Madison', 'WI', 43.0878, -89.4299, 280305),
    ('Chandler', 'AZ', 33.2828, -111.8518, 280167),
    ('Gilbert', 'AZ', 33.3103, -111.7431, 275411),
    ('Reno', 'NV', 39.5491, -119.8499, 274915),
    ('Buffalo', 'NY', 42.8925, -78.8597, 274678),
    ('Chula Vista', 'CA', 32.6277, -117.0152, 274333),
    ('Fort Wayne', 'IN', 41.0891, -85.1439, 269994),
    ('Lubbock', 'TX', 33.5619, -101.8889, 266878),
    ('Toledo', 'OH', 41.6641, -83.5819, 265304),
    ('St. Petersburg', 'FL', 27.7627, -82.6441, 263553),
    ('Laredo', 'TX', 27.5604, -99.4892, 257602),
    ('Irving', 'TX', 32.8577, -96.9700, 254373),
    ('Chesapeake', 'VA', 36.6794, -76.3018, 253886),
    ('Glendale', 'AZ', 33.5331, -112.1899, 253855),
    ('Winston-Salem', 'NC', 36.1029, -80.2608, 252975),
    ('Port St. Lucie', 'FL', 27.2806, -80.3883, 245021),
    ('Scottsdale', 'AZ', 33.6843, -111.8614, 244394),
    ('Garland', 'TX', 32.9098, -96.6303, 243470),
    ('Boise City', 'ID', 43.6002, -116.2317, 235421),
    ('Norfolk', 'VA', 36.9230, -76.2446, 230930),
    ('Spokane', 'WA', 47.6669, -117.4333, 229447),
    ('Richmond', 'VA', 37.5314, -77.4760, 229247),
    ('Fremont', 'CA', 37.4945, -121.9411, 226208),
    ('Huntsville', 'AL', 34.6977, -86.6767, 225564),
    ('Frisco', 'TX', 33.1554, -96.8226, 225007),
    ('Cape Coral', 'FL', 26.6432, -81.9974, 224455),
    ('Santa Clarita', 'CA', 34.4165, -118.5007, 224028),
    ('San Bernardino', 'CA', 34.1411, -117.2946, 223728),
    ('Tacoma', 'WA', 47.2522, -122.4598, 222906),
    ('Hialeah', 'FL', 25.8699, -80.3029, 221300),
    ('Baton Rouge', 'LA', 30.4404, -91.1332, 219573),
    ('Modesto', 'CA', 37.6375, -121.0030, 218915),
    ('Fontana', 'CA', 34.1097, -117.4629, 215465),
    ('McKinney', 'TX', 33.2011, -96.6642, 213509),
    ('Moreno Valley', 'CA', 33.9233, -117.2057, 212392),
    ('Des Moines', 'IA', 41.5726, -93.6102, 210381),
    ('Fayetteville', 'NC', 35.0828, -78.9735, 209749),
    ('Salt Lake City', 'UT', 40.7769, -111.9310, 209593),
    ('Yonkers', 'NY', 40.9459, -73.8674, 207657),
    ('Worcester', 'MA', 42.2695, -71.8078, 207621),
    ('Rochester', 'NY', 43.1699, -77.6169, 207274),
    ('Sioux Falls', 'SD', 43.5407, -96.7320, 206410),
    ('Little Rock', 'AR', 34.7254, -92.3586, 203842),
    ('Amarillo', 'TX', 35.1981, -101.8331, 202408),
    ('Tallahassee', 'FL', 30.4535, -84.2523, 202221),
    ('Grand Prairie', 'TX', 32.6861, -97.0208, 202134),
    ('Columbus', 'GA', 32.5102, -84.8749, 201877),
    ('Augusta-Richmond County', 'GA', 33.3655, -82.0734, 200884),
    ('Peoria', 'AZ', 33.7862, -112.3080, 198750),
    ('Oxnard', 'CA', 34.1994, -119.2075, 198488),
    ('Knoxville', 'TN', 35.9707, -83.9493, 198162),
    ('Overland Park', 'KS', 38.8890, -94.6906, 197089),
    ('Birmingham', 'AL', 33.5272, -86.7970, 196644),
    ('Grand Rapids', 'MI', 42.9612, -85.6556, 196608),
    ('Vancouver', 'WA', 45.6372, -122.5966, 196442),
    ('Montgomery', 'AL', 32.3485, -86.2673, 195287),
    ('Huntington Beach', 'CA', 33.6980, -118.0038, 192129),
    ('Providence', 'RI', 41.8231, -71.4188, 190792),
    ('Brownsville', 'TX', 25.9957, -97.4508, 190158),
    ('Tempe', 'AZ', 33.3884, -111.9318, 189834),
    ('Akron', 'OH', 41.0805, -81.5214, 188701),
    ('Glendale', 'CA', 34.1814, -118.2458, 187050),
    ('Chattanooga', 'TN', 35.0660, -85.2484, 187030),
    ('Fort Lauderdale', 'FL', 26.1412, -80.1467, 184255),
    ('Newport News', 'VA', 37.0761, -76.5220, 183118),
    ('Mobile', 'AL', 30.6684, -88.1002, 182595),
    ('Ontario', 'CA', 34.0376, -117.6044, 182457),
    ('Clarksville', 'TN', 36.5664, -87.3452, 180716),
    ('Cary', 'NC', 35.7813, -78.8234, 180010),
    ('Elk Grove', 'CA', 38.4146, -121.3850, 178444),
    ('Shreveport', 'LA', 32.4669, -93.7922, 177959),
    ('Eugene', 'OR', 44.0568, -123.1190, 177899),
    ('Aurora', 'IL', 41.7635, -88.2901, 177563),
    ('Salem', 'OR', 44.9239, -123.0230, 177432),
    ('Santa Rosa', 'CA', 38.4458, -122.7062, 175845),
    ('Rancho Cucamonga', 'CA', 34.1303, -117.5661, 174405),
    ('Pembroke Pines', 'FL', 26.0147, -80.3402, 171119),
    ('Fort Collins', 'CO', 40.5482, -105.0648, 170376),
    ('Springfield', 'MO', 37.1942, -93.2926, 170188),
    ('Oceanside', 'CA', 33.2246, -117.3063, 170020),
    ('Garden Grove', 'CA', 33.7788, -117.9605, 168234),
    ('Lancaster', 'CA', 34.6936, -118.1753, 166236),
    ('Murfreesboro', 'TN', 35.8539, -86.4212, 165430),
    ('Palmdale', 'CA', 34.5910, -118.1054, 161404),
    ('Corona', 'CA', 33.8620, -117.5655, 160238),
    ('Killeen', 'TX', 31.0777, -97.7320, 159643),
    ('Salinas', 'CA', 36.6902, -121.6338, 159506),
    ('Roseville', 'CA', 38.7703, -121.3196, 159135),
    ('Denton', 'TX', 33.2174, -97.1413, 158349),
    ('Surprise', 'AZ', 33.6708, -112.4525, 158285),
    ('Macon-Bibb County', 'GA', 32.8088, -83.6942, 156512),
    ('Paterson', 'NJ', 40.9148, -74.1628, 156452),
    ('Lakewood', 'CO', 39.6989, -105.1176, 155961),
    ('Hayward', 'CA', 37.6268, -122.1040, 155675),
    ('Charleston', 'SC', 32.8280, -79.9729, 155369),
    ('Alexandria', 'VA', 38.8193, -77.0837, 155230),
    ('Hollywood', 'FL', 26.0310, -80.1646, 153859),
    ('Springfield', 'MA', 42.1155, -72.5400, 153672),
    ('Kansas City', 'KS', 39.1225, -94.7418, 152933),
    ('Sunnyvale', 'CA', 37.3858, -122.0263, 151967),
    ('Bellevue', 'WA', 47.5978, -122.1565, 151574),
    ('Joliet', 'IL', 41.5177, -88.1488, 150489),
    ('Naperville', 'IL', 41.7492, -88.1620, 150245),
    ('Escondido', 'CA', 33.1331, -117.0740, 148122),
    ('Bridgeport', 'CT', 41.1874, -73.1958, 148028),
    ('Savannah', 'GA', 32.0180, -81.1965, 147748),
    ('Olathe', 'KS', 38.8820, -94.8201, 147461),
    ('Mesquite', 'TX', 32.7595, -96.5842, 147317),
    ('Pasadena', 'TX', 29.6550, -95.1511, 146716),
    ('McAllen', 'TX', 26.2250, -98.2461, 146593),
    ('Rockford', 'IL', 42.2588, -89.0646, 146120),
    ('Gainesville', 'FL', 29.6795, -82.3468, 145812),
    ('Syracuse', 'NY', 43.0410, -76.1436, 145560),
    ('Pomona', 'CA', 34.0585, -117.7611, 145502),
    ('Visalia', 'CA', 36.3280, -119.3285, 144998),
    ('Thornton', 'CO', 39.9204, -104.9414, 144922),
    ('Waco', 'TX', 31.5580, -97.1898, 144816),
    ('Jackson', 'MS', 32.3158, -90.2129, 143709),
    ('Columbia', 'SC', 34.0405, -80.9061, 142416),
    ('Fullerton', 'CA', 33.8857, -117.9280, 139250),
    ('Torrance', 'CA', 33.8305, -118.3566, 139224),
    ('Victorville', 'CA', 34.5277, -117.3536, 138869),
    ('Midland', 'TX', 32.0246, -102.1135, 138397),
    ('Orange', 'CA', 33.7870, -117.8613, 138337),
    ('Miramar', 'FL', 25.9725, -80.3386, 138319),
    ('Hampton', 'VA', 37.0480, -76.2973, 137098),
    ('Warren', 'MI', 42.4929, -83.0250, 136655),
    ('Stamford', 'CT', 41.0796, -73.5461, 136226),
    ('Cedar Rapids', 'IA', 41.9659, -91.6789, 135958),
    ('Elizabeth', 'NJ', 40.6664, -74.1935, 135829),
    ('Palm Bay', 'FL', 27.9649, -80.6583, 135566),
    ('Dayton', 'OH', 39.7847, -84.1996, 135512),
    ('New Haven', 'CT', 41.3108, -72.9250, 135319),
    ('Coral Springs', 'FL', 26.2707, -80.2593, 134906),
    ('Meridian', 'ID', 43.6115, -116.4007, 134801),
    ('West Valley City', 'UT', 40.6885, -112.0118, 134470),
    ('Pasadena', 'CA', 34.1606, -118.1380, 133560),
    ('Lewisville', 'TX', 33.0507, -96.9746, 133553),
    ('Kent', 'WA', 47.3880, -122.2127, 133378),
    ('Sterling Heights', 'MI', 42.5812, -83.0303, 133306),
    ('Fargo', 'ND', 46.8647, -96.8291, 133188),
    ('Carrollton', 'TX', 32.9894, -96.8999, 132918),
    ('Santa Clara', 'CA', 37.3646, -121.9680, 131062),
    ('Round Rock', 'TX', 30.5268, -97.6601, 130406),
    ('Norman', 'OK', 35.2406, -97.3453, 130046),
    ('Columbia', 'MO', 38.9473, -92.3264, 129330),
    ('Abilene', 'TX', 32.4545, -99.7381, 129043),
    ('Athens-Clarke County unified government', 'GA', 33.9496, -83.3701, 128628),
    ('Pearland', 'TX', 29.5557, -95.3230, 127736),
    ('Clovis', 'CA', 36.8290, -119.6849, 125826),
    ('Topeka', 'KS', 39.0347, -95.6948, 125475),
    ('College Station', 'TX', 30.5852, -96.2964, 125192),
    ('Simi Valley', 'CA', 34.2669, -118.7485, 125113),
    ('Allentown', 'PA', 40.5936, -75.4784, 124880),
    ('West Palm Beach', 'FL', 26.7451, -80.1270, 124130),
    ('Thousand Oaks', 'CA', 34.1933, -118.8742, 123463),
    ('Vallejo', 'CA', 38.1069, -122.2623, 122807),
    ('Wilmington', 'NC', 34.2092, -77.8858, 122698),
    ('Rochester', 'MN', 44.0143, -92.4786, 122413),
    ('Concord', 'CA', 37.9722, -122.0016, 122315),
    ('Lakeland', 'FL', 28.0555, -81.9548, 122264),
    ('North Charleston', 'SC', 32.9179, -80.0650, 121469),
    ('Lafayette', 'LA', 30.2056, -92.0281, 121467),
    ('Arvada', 'CO', 39.8337, -105.1503, 121414),
    ('Independence', 'MO', 39.0855, -94.3521, 120922),
    ('Billings', 'MT', 45.7885, -108.5525, 120864),
    ('Fairfield', 'CA', 38.2621, -122.0324, 120768),
    ('Hartford', 'CT', 41.7659, -72.6816, 119669),
    ('Ann Arbor', 'MI', 42.2761, -83.7309, 119381),
    ('Broken Arrow', 'OK', 36.0365, -95.7810, 119194),
    ('Berkeley', 'CA', 37.8657, -122.2987, 118962),
    ('Cambridge', 'MA', 42.3760, -71.1187, 118214),
    ('Richardson', 'TX', 32.9723, -96.7081, 117435),
    ('Antioch', 'CA', 37.9783, -121.7961, 117096),
    ('High Point', 'NC', 35.9908, -79.9927, 116926),
    ('Clearwater', 'FL', 27.9794, -82.7713, 116850),
    ('League City', 'TX', 29.4901, -95.1091, 116320),
    ('Odessa', 'TX', 31.8805, -102.3453, 115743),
    ('Manchester', 'NH', 42.9849, -71.4441, 115474),
    ('Evansville', 'IN', 37.9877, -87.5347, 115332),
    ('Waterbury', 'CT', 41.5585, -73.0367, 114990),
    ('West Jordan', 'UT', 40.6027, -112.0013, 114908),
    ('Las Cruces', 'NM', 32.3264, -106.7897, 114892),
    ('Westminster', 'CO', 39.8801, -105.0615, 114875),
    ('Lowell', 'MA', 42.6390, -71.3210, 114296),
    ('Nampa', 'ID', 43.5855, -116.5656, 114268),
    ('Richmond', 'CA', 37.9523, -122.3606, 114106),
    ('Pompano Beach', 'FL', 26.2416, -80.1339, 113619),
    ('Carlsbad', 'CA', 33.1293, -117.2842, 113495),
    ('Menifee', 'CA', 33.6899, -117.1844, 113433),
    ('Provo', 'UT', 40.2453, -111.6451, 113343),
    ('Elgin', 'IL', 42.0390, -88.3257, 113310),
    ('Greeley', 'CO', 40.4140, -104.7710, 112609),
    ('Springfield', 'IL', 39.7911, -89.6446, 112544),
    ('Beaumont', 'TX', 30.0849, -94.1453, 112193),
    ('Lansing', 'MI', 42.7143, -84.5609, 112115),
    ('Murrieta', 'CA', 33.5721, -117.1904, 111878),
    ('Goodyear', 'AZ', 33.2540, -112.3665, 111805),
    ('Allen', 'TX', 33.1097, -96.6730, 111620),
    ('Tuscaloosa', 'AL', 33.2344, -87.5283, 111338),
    ('Everett', 'WA', 47.9654, -122.1899, 111180),
    ('Pueblo', 'CO', 38.2692, -104.6108, 111077),
    ('New Braunfels', 'TX', 29.6993, -98.1151, 110958),
    ('South Fulton', 'GA', 33.6357, -84.5834, 110920),
    ('Miami Gardens', 'FL', 25.9489, -80.2436, 110717),
    ('Gresham', 'OR', 45.5023, -122.4416, 110685),
    ('Temecula', 'CA', 33.4931, -117.1317, 110682),
    ('Rio Rancho', 'NM', 35.2851, -106.6989, 110660),
    ('Peoria', 'IL', 40.7516, -89.6172, 110460),
    ('Tyler', 'TX', 32.3173, -95.3059, 110327),
    ('Sparks', 'NV', 39.5743, -119.7152, 110323),
    ('Concord', 'NC', 35.3921, -80.6355, 110119),
    ('Santa Maria', 'CA', 34.9331, -120.4436, 109987),
    ('San Buenaventura (Ventura)', 'CA', 34.2678, -119.2542, 109058),
    ('Buckeye', 'AZ', 33.4316, -112.6416, 108909),
    ('Downey', 'CA', 33.9382, -118.1309, 108816),
    ('Sugar Land', 'TX', 29.5928, -95.6338, 108515),
    ('Costa Mesa', 'CA', 33.6659, -117.9123, 108354),
    ('Conroe', 'TX', 30.3287, -95.4846, 108248),
    ('Spokane Valley', 'WA', 47.6634, -117.2328, 108235),
    ('Davie', 'FL', 26.0792, -80.2830, 107799),
    ('Hillsboro', 'OR', 45.5268, -122.9354, 107730),
    ('Jurupa Valley', 'CA', 34.0026, -117.4676, 107321),
    ('Centennial', 'CO', 39.5909, -104.8638, 106883),
    ('Boulder', 'CO', 40.0244, -105.2513, 105898),
    ('Dearborn', 'MI', 42.3131, -83.2115, 105811),
    ('Edinburg', 'TX', 26.3211, -98.1628, 105799),
    ('Sandy Springs', 'GA', 33.9315, -84.3689, 105793),
    ('Green Bay', 'WI', 44.5215, -87.9866, 105744),
    ('West Covina', 'CA', 34.0559, -117.9099, 105617),
    ('Brockton', 'MA', 42.0825, -71.0246, 104890),
    ('St. George', 'UT', 37.0770, -113.5765, 104578),
    ('Bend', 'OR', 44.0567, -121.3080, 104557),
    ('Renton', 'WA', 47.4792, -122.1946, 104491),
    ("Lee's Summit", 'MO', 38.9216, -94.3848, 104184),
    ('Fishers', 'IN', 39.9618, -85.9684, 104094),
    ('El Monte', 'CA', 34.0746, -118.0291, 103794),
    ('South Bend', 'IN', 41.6766, -86.2688, 103395),
    ('Rialto', 'CA', 34.1174, -117.3892, 103391),
    ('El Cajon', 'CA', 32.8017, -116.9605, 102991),
    ('Inglewood', 'CA', 33.9561, -118.3443, 102865),
    ('Burbank', 'CA', 34.1901, -118.3264, 102755),
    ('Wichita Falls', 'TX', 33.9067, -98.5258, 102691),
    ('Vacaville', 'CA', 38.3586, -121.9686, 102526),
    ('Carmel', 'IN', 39.9655, -86.1484, 102296),
    ('Palm Coast', 'FL', 29.5368, -81.2426, 102113),
    ('Fayetteville', 'AR', 36.0715, -94.1666, 101680),
    ('Quincy', 'MA', 42.2610, -71.0090, 101597),
    ('San Mateo', 'CA', 37.5603, -122.3106, 101327),
    ('Chico', 'CA', 39.7590, -121.8177, 101301),
    ('Lynn', 'MA', 42.4748, -70.9620, 101241),
    ('Albany', 'NY', 42.6657, -73.7984, 101228),
    ('Yuma', 'AZ', 32.5163, -114.5218, 100858),
    ('New Bedford', 'MA', 41.6613, -70.9379, 100695),
    ('Suffolk', 'VA', 36.6972, -76.6348, 100659),
    ('Hesperia', 'CA', 34.3970, -117.3152, 100633),
    ('Davenport', 'IA', 41.5568, -90.6039, 100354),
]

def haversine_miles(la1, lo1, la2, lo2):
    p1, p2 = math.radians(la1), math.radians(la2)
    dp, dl = p2 - p1, math.radians(lo2 - lo1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(a))


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "otterquote-storm-detector/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        sys.stderr.write("FETCH FAILED: %s HTTP %s %s\n" % (url, e.code, e.reason))
    except Exception as e:
        sys.stderr.write("FETCH FAILED: %s error: %s\n" % (url, e))
    sys.exit(2)


def parse(text, url, kind):
    rows = list(csv.DictReader(io.StringIO(text)))
    need = {"Size" if kind == "hail" else "Speed", "County", "State", "Lat", "Lon"}
    hdr = set(rows[0].keys()) if rows else set((text.splitlines() or [""])[0].split(","))
    if not need <= hdr:
        sys.stderr.write("FETCH FAILED: %s unexpected CSV header: %s\n" % (url, sorted(hdr)))
        sys.exit(2)
    return rows


def nearest_metro(lat, lon, radius):
    best = None
    for name, st, la, lo, pop in CITIES:
        d = haversine_miles(lat, lon, la, lo)
        if d <= radius and (best is None or d < best[0]):
            best = (d, name, st, pop)
    return best


def build_alerts(date, radius, statute):
    ymd = date.strftime("%y%m%d")
    events = []
    for kind in ("hail", "wind"):
        url = "%s%s_rpts_filtered_%s.csv" % (SPC_BASE, ymd, kind)
        for r in parse(fetch(url), url, kind):
            try:
                lat, lon = float(r["Lat"]), float(r["Lon"])
            except (ValueError, TypeError):
                continue
            if kind == "hail":
                try:
                    v = int(r["Size"]) / 100.0
                except ValueError:
                    continue
                if v < HAIL_MIN_IN:
                    continue
            else:
                try:
                    v = int(r["Speed"])
                except ValueError:
                    continue  # "UNK" wind speed cannot be shown to meet the 60 mph threshold
                if v < WIND_MIN_MPH:
                    continue
            st = r["State"].strip().upper()
            if st in BLOCKED_STATES:
                continue
            m = nearest_metro(lat, lon, radius)
            if not m:
                continue
            events.append((kind, v, st, r["County"].strip(), m))
    groups = {}
    for kind, v, st, county, m in events:
        g = groups.setdefault((st, m[1], m[2]), {
            "date": date.isoformat(), "state": st, "metro": m[1], "metro_state": m[2],
            "metro_population": m[3], "metro_distance_miles": m[0], "max_hail_in": None,
            "max_wind_mph": None, "counties": set(), "reports": 0})
        g["reports"] += 1
        g["counties"].add(county)
        g["metro_distance_miles"] = min(g["metro_distance_miles"], m[0])
        if kind == "hail":
            g["max_hail_in"] = v if g["max_hail_in"] is None else max(g["max_hail_in"], v)
        else:
            g["max_wind_mph"] = v if g["max_wind_mph"] is None else max(g["max_wind_mph"], v)
    searched = set(s.upper() for s in statute.get("searched", []))
    out = []
    for g in groups.values():
        g["counties"] = sorted(g["counties"])
        g["state_status"] = "searched" if g["state"] in searched else "unresearched"
        g["metro_distance_miles"] = round(g["metro_distance_miles"], 1)
        out.append(g)
    out.sort(key=lambda g: (-g["metro_population"], g["state"]))
    return out


def render_text(date, alerts, radius):
    lines = ["# Storm detector alerts for %s" % date.isoformat(), "",
             "Thresholds: hail >= %.2f in or wind >= %d mph, within %g miles of a 100k+ city; blocked states: %s."
             % (HAIL_MIN_IN, WIND_MIN_MPH, radius, ", ".join(sorted(BLOCKED_STATES))), ""]
    for g in alerts:
        mags = []
        if g["max_hail_in"] is not None:
            mags.append("max hail %.2f in" % g["max_hail_in"])
        if g["max_wind_mph"] is not None:
            mags.append("max wind %d mph" % g["max_wind_mph"])
        lines += ["## %s: %s, %s" % (g["date"], g["metro"], g["metro_state"]),
                  "- Date: %s" % g["date"],
                  "- Magnitude: %s" % ", ".join(mags),
                  "- Counties (%s): %s" % (g["state"], ", ".join(g["counties"])),
                  "- Nearest metro: %s, %s (population %s, %s mi from nearest report)"
                  % (g["metro"], g["metro_state"], format(g["metro_population"], ","), g["metro_distance_miles"]),
                  "- Reports: %d" % g["reports"],
                  "- State status: %s" % g["state_status"], ""]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    y = (datetime.now(timezone.utc) - timedelta(days=1)).date().isoformat()
    ap.add_argument("--date", default=y, help="YYYY-MM-DD (default: yesterday UTC)")
    ap.add_argument("--radius-miles", type=float, default=DEFAULT_RADIUS_MILES)
    ap.add_argument("--format", choices=["text", "json"], default="text")
    ap.add_argument("--out", help="write alert output here ONLY if >= 1 alert")
    ap.add_argument("--statute-file", default=DEFAULT_STATUTE_FILE)
    a = ap.parse_args()
    try:
        date = datetime.strptime(a.date, "%Y-%m-%d").date()
    except ValueError:
        sys.stderr.write("bad --date, expected YYYY-MM-DD\n")
        return 2
    try:
        with open(a.statute_file) as f:
            statute = json.load(f)
    except (OSError, ValueError) as e:
        sys.stderr.write("WARNING: statute file unreadable (%s); all states treated as unresearched\n" % e)
        statute = {"searched": []}
    alerts = build_alerts(date, a.radius_miles, statute)
    if a.format == "json":
        body = json.dumps({"date": date.isoformat(), "alerts": alerts}, indent=2)
    else:
        body = render_text(date, alerts, a.radius_miles) if alerts else \
            "No qualifying storm alerts for %s." % date.isoformat()
    print(body)
    if alerts and a.out:
        d = os.path.dirname(os.path.abspath(a.out))
        os.makedirs(d, exist_ok=True)
        with open(a.out, "w") as f:
            f.write(body + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
