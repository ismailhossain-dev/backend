require("dotenv").config();
//stripe key ta .env teke asce
const stripe = require("stripe")(process.env.STRIPE_SECRECT_KEY);

//
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString("utf-8");
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
// middleware
app.use(
  cors({
    origin: [
      process.env.CLIENT_DOMAIN,
      "http://localhost:5173",
      // "https://bookcourier-project.netlify.app",
      // "http://localhost:5173",
    ],
    credentials: true,
    optionSuccessStatus: 200,
  }),
);
app.use(express.json());

const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  // console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    // console.log(decoded);
    next();
  } catch (err) {
    // console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};
//

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
// async function run() {
// try {
//my code
const db = client.db("bookDB");
const bookCollection = db.collection("books");
//create collection for user
const userCollection = db.collection("user");
//create collection for orders
const ordersCollection = db.collection("orders");

const ContactCollection = db.collection("contactFrom");

//secure libairan user and admin
const verifyADMIN = async (req, res, next) => {
  const email = req.tokenEmail;
  const user = await userCollection.findOne({ email });
  if (user?.role !== "admin")
    return res.status(403).send({ message: "Admin only Actions!", role: user?.role });
  //jodi sey admin na hoy tahole take amra next te jethe divo
  next();
};
const verifySELLER = async (req, res, next) => {
  const email = req.tokenEmail;
  const user = await userCollection.findOne({ email });
  if (user?.role !== "seller")
    return res.status(403).send({ message: "Seller only Actions!", role: user?.role });
  //jodi sey admin na hoy tahole take amra next te jethe divo
  next();
};
//

//step-1  amra ekon mongodb te data patabo login and signup
app.post("/user", async (req, res) => {
  try {
    const userData = req.body;

    // basic validation
    if (!userData?.email) {
      return res.status(400).send({ message: "Email is required" });
    }

    const query = { email: userData.email };
    const existingUser = await userCollection.findOne(query);

    // user exists → update login time
    if (existingUser) {
      const result = await userCollection.updateOne(query, {
        $set: { lastLoggedIn: new Date() },
      });

      return res.status(200).send({
        message: "User login updated",
        result,
      });
    }

    // create new user
    const newUser = {
      email: userData.email,
      displayName: userData.displayName || "",
      photoURL: userData.photoURL || "",
      role: "user", // always backend
      createdAt: new Date(),
      lastLoggedIn: new Date(),
    };

    const result = await userCollection.insertOne(newUser);

    res.status(201).send({
      message: "User created successfully",
      result,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({
      message: "Internal server error",
    });
  }
});
app.post("/books", async (req, res) => {
  const BookData = req.body;
  //save bookCollection
  // console.log(BookData);
  const result = await bookCollection.insertOne(BookData);
  res.send(result);
});
//mongodb data anbo
app.get("/books", verifyJWT, verifySELLER, async (req, res) => {
  const result = await bookCollection.find().toArray();
  res.send(result);
});
//book single data use fronted
app.get("/books/:id", async (req, res) => {
  const id = req.params;
  const result = await bookCollection.findOne({ _id: new ObjectId(id) });
  res.send(result);
});
//stripe payment work
app.post("/create-checkout-session", async (req, res) => {
  const paymentInfo = req.body;

  // console.log(paymentInfo);
  const session = await stripe.checkout.sessions.create({
    line_items: [
      {
        price_data: {
          currency: "usd",
          //product_data gola payment from dekabe
          product_data: {
            name: paymentInfo?.customer.name,
            description: paymentInfo?.description,
            images: [paymentInfo?.image],
          },
          unit_amount: paymentInfo.price * 100,
        },
        quantity: 1,
      },
    ],
    mode: "payment",
    //product info set korthe hobe
    metadata: {
      // name: "Mohammad Ismail "
      bookId: paymentInfo?.bookId,
      customer: paymentInfo?.customer.email,
    },
    customer_email: paymentInfo.customer.email,
    success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `https://bookcourier-two.vercel.app/${paymentInfo.bookId}`,
  });
  res.send({ url: session.url });
});

//payment ending point
app.post("/payment-success", async (req, res) => {
  const { sessionId } = req.body;
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const book = await bookCollection.findOne({
    _id: new ObjectId(session.metadata.bookId),
  });
  // console.log(book);

  //amra ekane cheek data ta age tekge ki database ase kina
  const order = await ordersCollection.findOne({
    transactionId: session.payment_intent,
  });

  //jodi status complete hoy tokon orderInfo ta kaj korbe
  if (session.status === "complete" && book && !order) {
    // order info
    //session ta asche stripe teke
    const orderInfo = {
      bookId: session.metadata.bookId,
      transactionId: session.payment_intent,
      customer: session.metadata.customer,
      status: "pending",
      seller: book.details.publisher,
      name: book.title,
      category: book.category,
      quantity: 1,
      price: session.amount_total / 100,
      image: book?.image,
    };
    // console.log(orderInfo);
    const result = await ordersCollection.insertOne(orderInfo);
    // update book quantity eta korle amder query jodi 3 ta take tahole pay korar pore 1 ta quantity kome jabe
    await bookCollection.updateOne(
      {
        _id: new ObjectId(session.metadata.bookId),
      },
      { $inc: { quantity: -1 } },
    );

    return res.send({
      transactionId: session.payment_intent,
      orderId: result.insertedId,
    });
  }

  res.send({
    transactionId: session.payment_intent,
    orderId: order._id,
  });
});

//finished stripe payment
//Role Work anbo amra email er mardome

//amra akane my orders er data gola mongodb teke anbo
// anmader akane akta rounte dithe uporer route er sathe match na hoy motho
app.get("/my-orders", verifyJWT, async (req, res) => {
  const result = await ordersCollection.find({ customer: req.tokenEmail }).toArray();
  res.send(result);
});

//getting order librarian
app.get("/orders/:email", async (req, res) => {
  const query = {};
  const { email } = req.query.email;
  // /parcels?email=''&
  if (email) {
    query.senderEmail = email;
  }

  const options = { sort: { createdAt: -1 } };

  const cursor = ordersCollection.find(query, options);
  const result = await cursor.toArray();
  res.send(result);
});

//
app.get("/my-orders/:email", async (req, res) => {
  try {
    const email = req.params.email;
    const orders = await ordersCollection.find({ customer: email }).toArray();
    res.send(orders);
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Failed to fetch orders" });
  }
});

app.delete("/my-orders/:id", async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await ordersCollection.deleteOne(query);

  res.send(result);
});

//
//secure website work jtw
//getting role for useRole component
app.get("/user/role/:email", verifyJWT, async (req, res) => {
  const result = await userCollection.findOne({ email: req.tokenEmail });
  res.send({ role: result?.role });
});

app.delete("/my-inventory/:id", async (req, res) => {
  const id = req.params.id;
  const qury = { _id: new ObjectId(id) };
  const result = await ordersCollection.deleteOne(qury);
  res.send(result);
});

//delete order librarian
app.delete("/orders/:id", async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await ordersCollection.deleteOne(query);
  res.send(result);
});
//finishe role work
//  /mongodb teke data anchi
app.get("/homeBooks", async (req, res) => {
  const result = await bookCollection.find().limit(8).sort({ price: 1 }).toArray();
  res.send(result);
});
//AllBooks
app.get("/allBooks", async (req, res) => {
  const result = await bookCollection.find().sort({ price: 1 }).toArray();
  // console.log(result);
  res.send(result);
});

//Contact from

app.post("/contact", async (req, res) => {
  const newProduct = req.body;
  const result = await ContactCollection.insertOne(newProduct);
  res.send(result);
});
//admin work
// Manage users
app.get("/users", verifyJWT, verifyADMIN, async (req, res) => {
  const adminEmail = req.tokenEmail;
  const result = await userCollection.find({ email: { $ne: adminEmail } }).toArray();

  res.send(result);
});
//Manage users delete
app.delete("/users/:id", async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await userCollection.deleteOne(query);
  res.send(result);
});

//mange user update
app.patch("/users/:email", async (req, res) => {
  const email = req.params.email;
  const userInfo = req.body;
  console.log(userInfo);

  const query = { email };

  const updateDoc = {
    $set: {
      displayName: userInfo.displayName,
    },
  };

  const result = await userCollection.updateOne(query, updateDoc);
  res.send(result);
});

// Manage Books api
app.get("/manage-books", async (req, res) => {
  const result = await ordersCollection.find().toArray();
  res.send(result);
});
//profile update api
app.patch("/users/:email", async (req, res) => {
  const email = req.params.email;
  console.log(email);
  const profileInfo = req.body;

  const query = { email: email };
  const updateDoc = {
    $set: {
      displayName: profileInfo.displayName,
      photoURL: profileInfo.photoURL,
    },
  };

  const result = await userCollection.updateOne(query, updateDoc);
  res.send(result);
});

//mange books delete api
app.delete("/manage-books/:id", async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await ordersCollection.deleteOne(query);
  res.send(result);
});

//mange books update api
app.patch("/manage-books/:email", async (req, res) => {
  const email = req.params.email;
  const bookInfo = req.body;

  const query = { email: email };

  const updateDoc = {
    $set: bookInfo,
  };

  const result = await ordersCollection.updateOne(query, updateDoc);
  res.send(result);
});
// Send a ping to confirm a successful connection
// await client.db("admin").command({ ping: 1 });
console.log("Pinged your deployment. You successfully connected to MongoDB!");

app.get("/", (req, res) => {
  res.send("Nice Assignment 11");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
